<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { getProjectStore, type RecentProject } from "../stores/project";
import NewProjectDialog from "./NewProjectDialog.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import "../../styles/components/home-view.scss";
import { emit } from "@tauri-apps/api/event";
import { revealItemInDir, openUrl } from "@tauri-apps/plugin-opener";
import { confirm } from "../lib/confirm";
import { isTauri } from "../../lib/tauri-env";
import { api } from "../../lib/api";
import {
  listScriptPrototypes,
  writeScriptPrototype,
  deleteScriptPrototype,
  type ScriptPrototype,
} from "../lib/script-prototypes";
import { BUILTIN_PROJECT_TEMPLATES, type ProjectTemplate } from "../lib/project-templates";
import { PREFS_CATS, THEME_COLOR_DEFS } from "../lib/home-helpers";
import {
  loadDefaultProjectDir,
  saveDefaultProjectDir,
} from "../lib/default-project-dir";
import {
  devtools,
  setDevToolsPort,
  setToolEnabled,
  enabledMcpTools,
  sanitizeMcpName,
  syncPermsFromBackend,
} from "../lib/devtools/state";
import {
  startDevTools,
  stopDevTools,
  syncDevToolsStatus,
} from "../lib/devtools";
import {
  groupDevToolsTools,
  mcpEndpointOf,
  mcpStdioCommandOf,
  mcpConfigJson,
  mcpStdioConfigJson,
} from "../lib/devtools/devtools-format";

const projectStore = getProjectStore();

type Section = "projects" | "templates" | "workshop" | "prefs" | "dev";
const section = ref<Section>("projects");
const prefsCat = ref("theme");

const showNewProject = ref(false);
const menuPath = ref<string | null>(null);
const busy = ref(false);

/** 默认项目位置（新建项目默认父目录） */
const defaultProjectDir = ref("");
const prefBusy = ref(false);

/** 工程模板（内置数据驱动；后续可接入后端自定义模板） */
const templates = ref<ProjectTemplate[]>(BUILTIN_PROJECT_TEMPLATES);

// 代码工坊：脚本原型（repos/code 目录下的独立 .ts 文件；一原型一文件）
const protoList = ref<ScriptPrototype[]>([]);
const protoForm = reactive({ open: false, editingId: "", name: "", description: "", code: "" });

/** 刷新原型清单（repos/code 目录 *.ts） */
async function refreshProtos(): Promise<void> {
  protoList.value = await listScriptPrototypes();
}

/** 打开添加/编辑表单 */
function openProtoForm(p?: ScriptPrototype): void {
  protoForm.open = true;
  protoForm.editingId = p?.id ?? "";
  protoForm.name = p?.name ?? "";
  protoForm.description = p?.description ?? "";
  protoForm.code = p?.code ?? "";
}

/** 保存表单（新增或编辑自定义原型；整表覆写到后端） */
async function saveProtoForm(): Promise<void> {
  const name = protoForm.name.trim();
  if (!name) {
    alert("请填写原型名称");
    return;
  }
  if (!protoForm.code.trim()) {
    alert("请填写原型代码（可用 {{CLASS_NAME}} 占位符）");
    return;
  }
  try {
    // 一个原型一个独立文件：public/repos/code/<名称>.ts
    await writeScriptPrototype(name, protoForm.description.trim(), protoForm.code);
    // 编辑时改名 = 另存新文件 + 删除旧文件
    if (protoForm.editingId && protoForm.editingId !== `${name}.ts`) {
      await deleteScriptPrototype(protoForm.editingId);
    }
  } catch (e) {
    alert(`保存失败：${e}`);
    return;
  }
  protoForm.open = false;
  await refreshProtos();
}

/** 删除原型（删除对应 repos/code/*.ts 文件） */
async function removeProto(p: ScriptPrototype): Promise<void> {
  if (
    !(await confirm({
      title: "删除原型",
      message: `确定删除原型「${p.name}」？将删除文件 ${p.id}`,
      confirmText: "删除",
      danger: true,
    }))
  ) {
    return;
  }
  try {
    await deleteScriptPrototype(p.id);
  } catch (e) {
    alert(`删除失败：${e}`);
    return;
  }
  await refreshProtos();
}

/** 运行环境标记（开发者服务页控制服务器等功能开关用） */
const inTauri = isTauri();

/** 开发文档外链（开发者服务页展示） */
const DOC_LINKS = [
  {
    name: "TypeScript 手册",
    desc: "脚本与插件开发的语言参考",
    url: "https://www.typescriptlang.org/docs/",
  },
];

onMounted(() => {
  projectStore.refreshRecent();
  void refreshProtos();
  void loadDefaultProjectDir().then((dir) => {
    defaultProjectDir.value = dir;
  });
  if (inTauri) {
    // 开发者服务·控制服务器：仅同步展示状态（命令监听器只在编辑器窗口安装）
    void syncDevToolsStatus();
    // 工具权限：Rust 为权威存储，启动时同步一次（同时回写 localStorage 镜像）
    void syncPermsFromBackend();
  }
});

async function browseAndOpen() {
  busy.value = true;
  try {
    const p = await projectStore.pickFolder();
    if (p) await openProject(p);
  } finally {
    busy.value = false;
  }
}

async function openProject(project: RecentProject | string) {
  const path = typeof project === "string" ? project : project.path;
  busy.value = true;
  const success = await projectStore.openProject(path);
  busy.value = false;
  if (!success) {
    alert("打开项目失败");
    return;
  }
  await handoffToEditor();
}

/**
 * 打开/新建项目成功后交接给编辑器窗口（双窗口架构）：
 * 广播 home:project-opened（编辑器窗口同步状态并装载场景），
 * 再请求 Rust 显示编辑器窗口并隐藏首页。
 */
async function handoffToEditor(): Promise<void> {
  if (!inTauri) {
    // 浏览器环境无窗口系统，回退单窗口视图切换
    projectStore.setView("editor");
    return;
  }
  const root = projectStore.currentPath;
  if (!root) return;
  try {
    await emit("home:project-opened", {
      root,
      name: projectStore.projectName ?? "",
      rel: projectStore.sceneRel,
    });
    await api.showEditorWindow();
  } catch (e) {
    console.error("切换到编辑器窗口失败:", e);
    alert("切换到编辑器窗口失败：" + e);
  }
}

function onOpenProject(path: string) {
  menuPath.value = null;
  void openProject(path);
}

function openNewProject() {
  showNewProject.value = true;
  menuPath.value = null;
}

function closeNewProject() {
  showNewProject.value = false;
}

async function handleProjectCreated(project: RecentProject) {
  projectStore.addRecent(project);
  showNewProject.value = false;
  await handoffToEditor();
}

async function removeProject(path: string) {
  // 最近记录现在由后端持久化：仅本地移除会在下次 refresh 时复活，需同步后端
  try {
    await api.removeRecentProject(path);
  } catch (e) {
    console.error("移除最近记录失败:", e);
  }
  await projectStore.removeRecent(path);
  await projectStore.refreshRecent();
  menuPath.value = null;
}

async function trashProject(path: string, name: string) {
  const ok = await confirm({
    title: "移动到垃圾篓",
    message: `确定要把项目「${name}」移入回收站吗？\n项目文件将从磁盘移除，可从系统回收站恢复。`,
    confirmText: "移入回收站",
    danger: true,
  });
  if (!ok) return;
  menuPath.value = null;
  try {
    await api.trashPath(path);
  } catch (e) {
    console.error("移入回收站失败:", e);
    alert("移入回收站失败");
    return;
  }
  // 移入回收站后同步清除后端最近记录（尽力而为；避免旧路径残留、系统回收站恢复后复活）
  try {
    await api.removeRecentProject(path);
  } catch (e) {
    console.error("清除最近记录失败:", e);
  }
  await projectStore.removeRecent(path);
  await projectStore.refreshRecent();
}

async function renameProject(path: string, name: string) {
  const newName = window.prompt("新项目名:", name);
  if (!newName || newName.trim() === name) return;
  menuPath.value = null;
  try {
    await api.renameProject(path, newName.trim());
    await projectStore.refreshRecent();
  } catch (e) {
    console.error("重命名失败:", e);
    alert("重命名失败: " + e);
  }
}

async function revealFolder(path: string) {
  try {
    await revealItemInDir(path);
  } catch (e) {
    console.error("打开目录失败:", e);
  }
}

function toggleMenu(path: string) {
  menuPath.value = menuPath.value === path ? null : path;
}

function closeMenu() {
  menuPath.value = null;
}

// ---------------------------------------------------------------------------
// 开发者服务：控制服务器与开发文档入口
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 开发者服务·控制服务器：本地 TCP（换行分隔 JSON）+ MCP 端点。
// 命令由编辑器窗口执行；本窗口只负责启停、端口/权限配置与连接信息展示。
// ---------------------------------------------------------------------------

/** 启停进行中标记 */
const devSvcBusy = ref(false);
/** 工具权限按分组展示 */
const groupedDevTools = computed(() => groupDevToolsTools(devtools.tools));
/** MCP 已暴露工具（按权限过滤 + MCP 合法名） */
const enabledMcpToolsList = computed(() =>
  enabledMcpTools().map((t) => ({ ...t, mcpName: sanitizeMcpName(t.name) })),
);
const mcpEndpoint = computed(() => mcpEndpointOf(devtools.info, devtools.port));
const mcpStdioCommand = computed(() => mcpStdioCommandOf(devtools.info));
const mcpConfig = computed(() => mcpConfigJson(mcpEndpoint.value));
const mcpStdioConfig = computed(() => mcpStdioConfigJson(mcpStdioCommand.value, devtools.port));

/** 启用/停用本地控制服务器（复选框；执行端在编辑器窗口，启停命令全局生效） */
async function toggleDevService(e: Event): Promise<void> {
  const on = (e.target as HTMLInputElement).checked;
  if (!inTauri) {
    (e.target as HTMLInputElement).checked = false;
    alert("开发者服务控制服务器仅桌面端可用");
    return;
  }
  devSvcBusy.value = true;
  try {
    if (on) await startDevTools();
    else await stopDevTools();
  } catch (err) {
    devtools.enabled = false;
    alert(`开发者服务启动失败：${err}`);
  } finally {
    devSvcBusy.value = false;
  }
}

/** 复制提示（2 秒消失） */
const showCopyToast = ref(false);
let copyToastTimer: ReturnType<typeof setTimeout> | null = null;
async function copyDevToolsText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showCopyToast.value = true;
    if (copyToastTimer) clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(() => (showCopyToast.value = false), 2000);
  } catch (e) {
    console.error("复制失败:", e);
  }
}

/** 打开开发文档外链（Tauri 内走 opener 插件，浏览器环境回退新标签页） */
async function openDocLink(url: string) {
  try {
    if (inTauri) await openUrl(url);
    else window.open(url, "_blank", "noopener");
  } catch (e) {
    console.error("打开链接失败:", e);
  }
}

async function browseDefaultDir() {
  prefBusy.value = true;
  try {
    const dir = await projectStore.pickFolder();
    if (dir) {
      defaultProjectDir.value = dir;
      await saveDefaultProjectDir(dir);
    }
  } finally {
    prefBusy.value = false;
  }
}

async function onChangeDefaultDir() {
  await saveDefaultProjectDir(defaultProjectDir.value);
}

watch(showNewProject, (val) => {
  if (!val) closeMenu();
});
</script>

<template>
  <div class="home" @click="closeMenu">
    <div class="home-body">
      <!-- 左侧导航 -->
      <nav class="home-nav">
        <button
          :class="{ active: section === 'projects' }"
          @click="section = 'projects'"
        >
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">
            <path d="M1.5 3.5h4l1.6 2h7.4v7.5H1.5z" />
          </svg>
          <span>项目</span>
        </button>
        <button
          :class="{ active: section === 'templates' }"
          @click="section = 'templates'"
        >
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">
            <rect x="2" y="2" width="5.2" height="5.2" rx="1" />
            <rect x="8.8" y="2" width="5.2" height="5.2" rx="1" />
            <rect x="2" y="8.8" width="5.2" height="5.2" rx="1" />
            <path d="M8.8 11.4h5.2M11.4 8.8v5.2" />
          </svg>
          <span>模板</span>
        </button>
        <button
          :class="{ active: section === 'prefs' }"
          @click="section = 'prefs'"
        >
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
            <path d="M2 4.5h12" />
            <path d="M2 8h12" />
            <path d="M2 11.5h12" />
            <circle cx="5.5" cy="4.5" r="1.7" fill="var(--bg-panel)" />
            <circle cx="10.5" cy="8" r="1.7" fill="var(--bg-panel)" />
            <circle cx="6.5" cy="11.5" r="1.7" fill="var(--bg-panel)" />
          </svg>
          <span>偏好设置</span>
        </button>
        <button
          :class="{ active: section === 'workshop' }"
          @click="section = 'workshop'"
        >
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 4.5a1.5 1.5 0 0 1 3 0V12a1.5 1.5 0 0 1-3 0z" />
            <path d="M6 12.5h6a1 1 0 0 0 1-1v-1.5" />
            <path d="M8.5 5 7 6.5 8.5 8M11 5l1.5 1.5L11 8" />
          </svg>
          <span>代码工坊</span>
        </button>
        <button
          :class="{ active: section === 'dev' }"
          @click="section = 'dev'"
        >
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5.5 4 2.5 8l3 4" />
            <path d="M10.5 4l3 4-3 4" />
          </svg>
          <span>开发者服务</span>
        </button>
      </nav>

      <!-- 主区域 -->
      <main class="home-main">
        <!-- ========== 项目管理 ========== -->
        <section v-if="section === 'projects'" class="page">
          <div class="page-head">
            <div>
              <h2>项目</h2>
              <p class="sub">管理你的工程</p>
            </div>
            <div class="head-actions">
              <button :disabled="busy" @click="browseAndOpen">
                {{ busy ? "打开中…" : "打开" }}
              </button>
              <button class="primary" @click="openNewProject">新建项目</button>
            </div>
          </div>

          <div v-if="projectStore.recent.length === 0" class="empty">
            <div class="empty-icon">
              <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
            </div>
            <p>还没有打开过项目</p>
            <button class="primary" @click="openNewProject">新建项目</button>
          </div>

          <div v-else class="project-grid">
            <div
              v-for="p in projectStore.recent"
              :key="p.path"
              class="project-card"
              @click="onOpenProject(p.path)"
            >
              <div class="card-top">
                <span class="card-icon">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  </svg>
                </span>
                <button
                  class="card-menu"
                  title="更多操作"
                  @click.stop="toggleMenu(p.path)"
                >
                  ⋯
                </button>
              </div>
              <div class="card-name" :title="p.name">{{ p.name }}</div>
              <div class="card-meta">
                <span>{{ p.sceneCount }} 个场景</span>
                <span class="card-path" :title="p.path">{{ p.path }}</span>
              </div>

              <!-- 卡片操作菜单 -->
              <div v-if="menuPath === p.path" class="card-menu-pop" @click.stop>
                <button @click="onOpenProject(p.path)">打开项目</button>
                <button @click="revealFolder(p.path)">在文件夹中显示</button>
                <button @click="renameProject(p.path, p.name)">重命名项目</button>
                <button class="danger" @click="trashProject(p.path, p.name)">移动到垃圾篓</button>
                <button class="danger" @click="removeProject(p.path)">从列表移除</button>
              </div>
            </div>
          </div>
        </section>

        <!-- ========== 模板管理 ========== -->
        <section v-if="section === 'templates'" class="page">
          <div class="page-head">
            <div>
              <h2>模板</h2>
              <p class="sub">项目创建时使用的页面骨架</p>
            </div>
          </div>

          <div class="settings-card">
            <h3>工程模板</h3>
            <p class="sub">项目创建时使用的页面骨架（新建面板可选择）</p>
            <div v-if="templates.length === 0" class="tpl-empty">暂无工程模板。</div>
            <div v-for="t in templates" :key="t.id" class="tpl-row">
              <div class="tpl-info">
                <div class="tpl-name">{{ t.name }}</div>
                <div class="tpl-desc">{{ t.description }}</div>
              </div>
              <span class="tpl-tag">{{ t.builtin ? "内置" : "自定义" }}</span>
            </div>
          </div>
        </section>

        <!-- ========== 偏好设置 ========== -->
        <section v-if="section === 'prefs'" class="page">
          <div class="page-head">
            <div>
              <h2>偏好设置</h2>
              <p class="sub">编辑器外观与默认项目位置</p>
            </div>
          </div>

          <!-- 顶部类别栏 -->
          <div class="prefs-tabs">
            <button
              v-for="c in PREFS_CATS"
              :key="c.id"
              class="prefs-tab"
              :class="{ active: prefsCat === c.id }"
              @click="prefsCat = c.id"
            >
              {{ c.label }}
            </button>
          </div>

          <!-- 主题设置 -->
          <template v-if="prefsCat === 'theme'">
            <div class="settings-card">
              <h3>主题</h3>
              <div class="theme-colors">
                <div class="theme-color-grid">
                  <div
                    v-for="def in THEME_COLOR_DEFS"
                    :key="def.label"
                    class="theme-color-item"
                  >
                    <span class="theme-color-label">{{ def.label }}</span>
                    <input class="color-input" type="color" :value="def.defaultValue" />
                    <span class="mono color-hex">{{ def.defaultValue }}</span>
                    <button class="tpl-remove theme-color-reset">重置</button>
                  </div>
                </div>
                <div class="theme-color-actions">
                  <button>全部重置</button>
                </div>
              </div>
              <p class="hint">编辑器仅提供深色主题；颜色自定义与持久化待接入。</p>
            </div>
          </template>

          <!-- 项目设置 -->
          <template v-if="prefsCat === 'project'">
            <div class="settings-card">
              <h3>项目</h3>
              <div class="set-row">
                <label>默认项目位置</label>
                <input
                  v-model="defaultProjectDir"
                  type="text"
                  placeholder="选择新建项目的默认父目录"
                  @change="onChangeDefaultDir"
                />
                <button :disabled="prefBusy" @click="browseDefaultDir">
                  {{ prefBusy ? "打开中…" : "浏览…" }}
                </button>
              </div>
              <p class="hint">新建项目时默认使用该位置；留空则每次手动选择。</p>
            </div>
          </template>

          <!-- 关于 -->
          <template v-if="prefsCat === 'about'">
            <div class="settings-card">
              <h3>关于</h3>
              <div class="about-row">
                <span>v0.1.0</span>
                <span class="dim">开发测试版</span>
              </div>
            </div>
          </template>
        </section>

        <!-- ========== 代码工坊 ========== -->
        <section v-if="section === 'workshop'" class="page">
          <div class="page-head">
            <div>
              <h2>代码工坊</h2>
              <p class='sub'>脚本原型：沉淀可复用的脚本模板，资产面板「新建脚本」时选用</p>
            </div>
            <div class="head-actions">
              <button class="primary" @click="openProtoForm()">添加原型</button>
            </div>
          </div>

          <div v-if="protoForm.open" class="settings-card proto-form">
            <h3>{{ protoForm.editingId ? "编辑原型" : "添加原型" }}</h3>
            <div class="proto-field">
              <label>名称</label>
              <input v-model="protoForm.name" placeholder="旋转脚本" />
            </div>
            <div class="proto-field">
              <label>描述</label>
              <input v-model="protoForm.description" placeholder="一句话说明用途（可选）" />
            </div>
            <div class="proto-field">
              <label>代码（支持 <span v-pre>{{CLASS_NAME}}</span> 占位符，创建脚本时替换为脚本类名）</label>
              <textarea v-model="protoForm.code" rows="12" spellcheck="false"></textarea>
            </div>
            <div class="proto-form-actions">
              <button @click="protoForm.open = false">取消</button>
              <button class="primary" @click="saveProtoForm">保存</button>
            </div>
          </div>

          <div class="proto-grid">
            <div v-for="p in protoList" :key="p.id" class="proto-card">
              <div class="proto-head">
                <span class="proto-name">{{ p.name }}</span>
                <span class="proto-file">{{ p.id }}</span>
              </div>
              <p class="proto-desc">{{ p.description || "（无描述）" }}</p>
              <pre class="proto-code">{{ p.code }}</pre>
              <div class="proto-actions">
                <button @click="openProtoForm(p)">编辑</button>
                <button @click="removeProto(p)">删除</button>
              </div>
            </div>
          </div>
        </section>

        <!-- ========== 开发者服务 ========== -->
        <section v-if="section === 'dev'" class="page">
          <div class="page-head">
            <div>
              <h2>开发者服务</h2>
              <p class="sub">调试工具与开发文档</p>
            </div>
          </div>

          <!-- 控制服务器：本地 TCP + MCP 端点（外部工具远程操控编辑器） -->
          <div class="settings-card">
            <h3>控制服务器</h3>
            <template v-if="inTauri">
              <div class="devtools-controls">
                <div class="devtools-field">
                  <input
                    id="dev-svc-toggle"
                    type="checkbox"
                    :checked="devtools.enabled"
                    :disabled="devSvcBusy"
                    @change="toggleDevService"
                  />
                  <label for="dev-svc-toggle">启用服务</label>
                </div>
                <div class="devtools-field">
                  <label for="dev-svc-port">固定端口</label>
                  <input
                    id="dev-svc-port"
                    class="devtools-port"
                    type="number"
                    min="0"
                    max="65535"
                    :value="devtools.port"
                    @change="
                      setDevToolsPort(Number(($event.target as HTMLInputElement).value) || 0)
                    "
                  />
                  <span class="dim">0 = 随机端口；重启服务后生效</span>
                </div>
                <span class="dim devtools-status">
                  {{
                    devtools.enabled && devtools.info
                      ? `已启用 · ${devtools.info.url}`
                      : "启用后外部工具可经本地 TCP / MCP 操控编辑器"
                  }}
                </span>
              </div>
              <p v-if="devtools.error" class="devtools-err">{{ devtools.error }}</p>
              <p class="hint">
                应用启动时自动开启（默认端口 39100，被占用自动换随机端口）。
                协议：换行分隔 JSON（请求 {"id":1,"method":"editor.state","params":{}}），
                同一端口提供 MCP streamable-http 端点 /mcp。命令由编辑器窗口按下方
                「工具权限」执行；在此停用后本次运行不再自动开启。
              </p>
            </template>
            <p v-else class="hint">当前为浏览器直开环境，控制服务器不可用。</p>
          </div>

          <!-- 工具权限：每个工具可单独启用/禁用（禁用后远程调用返回错误） -->
          <div class="settings-card">
            <h3>工具权限</h3>
            <div class="devtools-groups">
              <div v-for="g in groupedDevTools" :key="g.group" class="devtools-group">
                <div class="devtools-group-title">{{ g.group }}</div>
                <label v-for="t in g.tools" :key="t.id" class="devtools-row">
                  <input
                    type="checkbox"
                    :checked="t.enabled"
                    @change="
                      setToolEnabled(t.id, ($event.target as HTMLInputElement).checked)
                    "
                  />
                  <span>{{ t.name }}</span>
                </label>
              </div>
            </div>
            <p class="hint">关闭的工具对 TCP 与 MCP 同时生效；MCP 只暴露已启用的工具。</p>
          </div>

          <!-- MCP 服务：外部 AI 客户端（Claude / Cursor 等）接入配置 -->
          <div class="settings-card">
            <h3>MCP 服务</h3>
            <div class="about-row">
              <span>服务名</span>
              <span class="dim mono">tve-devtools</span>
            </div>
            <div class="about-row">
              <span>HTTP 端点</span>
              <span
                class="devtools-code mono"
                title="点击复制"
                @click="copyDevToolsText(mcpEndpoint)"
              >
                {{ mcpEndpoint }}
              </span>
            </div>
            <div class="mcp-tools">
              <div v-for="t in enabledMcpToolsList" :key="t.mcpName" class="mcp-tool">
                <span class="mono mcp-tool-name">{{ t.mcpName }}</span>
                <span class="dim mcp-tool-desc">{{ t.description }}</span>
              </div>
            </div>
            <details>
              <summary>streamable-http 配置</summary>
              <pre
                class="devtools-code mono"
                title="点击复制"
                @click="copyDevToolsText(mcpConfig)"
              >{{ mcpConfig }}</pre>
            </details>
            <details>
              <summary>stdio 配置</summary>
              <pre
                class="devtools-code mono"
                title="点击复制"
                @click="copyDevToolsText(mcpStdioConfig)"
              >{{ mcpStdioConfig }}</pre>
            </details>
          </div>

          <!-- 文档与资源 -->
          <div class="settings-card">
            <h3>文档与资源</h3>
            <div v-for="d in DOC_LINKS" :key="d.url" class="tpl-row">
              <div class="tpl-info">
                <div class="tpl-name">{{ d.name }}</div>
                <div class="tpl-desc">{{ d.desc }}</div>
              </div>
              <button @click="openDocLink(d.url)">打开</button>
            </div>
          </div>
        </section>
      </main>
    </div>

    <!-- 复制成功提示（开发者服务·端点/配置复制） -->
    <Transition name="fade">
      <div v-if="showCopyToast" class="copy-toast">已复制到剪贴板</div>
    </Transition>

    <!-- 全局确认弹窗（首页窗口独立挂载：垃圾篓/移除等 confirm 依赖它） -->
    <ConfirmDialog />

    <NewProjectDialog
      v-if="showNewProject"
      @close="closeNewProject"
      @created="handleProjectCreated"
    />
  </div>
</template>