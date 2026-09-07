<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { version as vueVersion } from "vue";
import { REVISION as threeRevision } from "three";
import { getProjectStore, type RecentProject } from "../stores/project";
import NewProjectDialog from "./NewProjectDialog.vue";
import "../../styles/components/home-view.scss";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { revealItemInDir, openUrl, openPath } from "@tauri-apps/plugin-opener";
import { confirm } from "../lib/confirm";
import { isTauri } from "../../lib/tauri-env";
import { debugLog } from "../../lib/debug-log";
import { api } from "../../lib/api";
import { BUILTIN_PROJECT_TEMPLATES, type ProjectTemplate } from "../lib/project-templates";
import { PREFS_CATS, THEME_COLOR_DEFS } from "../lib/home-helpers";
import {
  loadDefaultProjectDir,
  saveDefaultProjectDir,
} from "../lib/default-project-dir";

const projectStore = getProjectStore();

type Section = "projects" | "templates" | "prefs" | "dev";
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

/** 运行环境信息（开发者服务页展示） */
const inTauri = isTauri();
const tauriVersion = ref("");

/** 开发文档外链（开发者服务页展示） */
const DOC_LINKS = [
  {
    name: "three.js 文档",
    desc: "场景、材质、相机等底层渲染 API 参考",
    url: "https://threejs.org/docs/",
  },
  {
    name: "Tauri v2 文档",
    desc: "桌面端窗口、文件系统与插件能力",
    url: "https://tauri.app/start/",
  },
  {
    name: "TypeScript 手册",
    desc: "脚本与插件开发的语言参考",
    url: "https://www.typescriptlang.org/docs/",
  },
];

onMounted(() => {
  projectStore.refreshRecent();
  void loadDefaultProjectDir().then((dir) => {
    defaultProjectDir.value = dir;
  });
  if (inTauri) {
    getVersion()
      .then((v) => (tauriVersion.value = v))
      .catch(() => (tauriVersion.value = ""));
    // 应用目录（开发者服务·桌面客户端卡片展示 + openPath 打开）
    void invoke<Array<[string, string]>>("dev_app_dirs")
      .then((dirs) => (appDirs.value = dirs))
      .catch(() => (appDirs.value = []));
    void refreshWindowState();
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
    await invoke("show_editor_window");
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
  await projectStore.removeRecent(path);
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
    await invoke("trash_path", { path });
    await projectStore.removeRecent(path);
    await projectStore.refreshRecent();
  } catch (e) {
    console.error("移入回收站失败:", e);
    alert("移入回收站失败");
  }
}

async function renameProject(path: string, name: string) {
  const newName = window.prompt("新项目名:", name);
  if (!newName || newName.trim() === name) return;
  menuPath.value = null;
  try {
    await invoke("rename_project", { path, newName: newName.trim() });
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
// 开发者服务：运行环境信息、调试工具与开发文档入口
// ---------------------------------------------------------------------------

/** 打开 WebView 开发者工具（调试构建可用；发行构建未启用 devtools 时报错提示） */
async function openDevtools() {
  try {
    await invoke("open_devtools");
  } catch (e) {
    console.error("打开开发者工具失败:", e);
    alert("打开开发者工具失败：" + e);
  }
}

/** 写入一条调试日志（应用配置目录 debug.log），验证日志链路是否可用 */
function writeTestDebugLog() {
  debugLog("dev", `来自首页的测试日志 ${new Date().toLocaleString()}`);
  alert("已写入测试日志。\n日志文件：应用配置目录下的 debug.log");
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

// ---------------------------------------------------------------------------
// 开发者服务·桌面客户端：窗口操作 / WebView 重载 / 应用目录
// ---------------------------------------------------------------------------

const appDirs = ref<Array<[string, string]>>([]);

/** 窗口状态（操作后刷新；置顶无法查询，本地跟踪开关状态） */
const winMaximized = ref(false);
const winFullscreen = ref(false);
const winAlwaysOnTop = ref(false);

async function refreshWindowState(): Promise<void> {
  try {
    const w = getCurrentWindow();
    winMaximized.value = await w.isMaximized();
    winFullscreen.value = await w.isFullscreen();
  } catch {
    /* 权限缺失时忽略 */
  }
}

/** 用系统文件管理器打开本地目录 */
async function openDir(path: string): Promise<void> {
  try {
    await openPath(path);
  } catch (e) {
    console.error("打开目录失败:", e);
    alert("打开目录失败：" + e);
  }
}

function winMinimize(): void {
  void getCurrentWindow().minimize();
}

function winToggleMaximize(): void {
  void getCurrentWindow()
    .toggleMaximize()
    .then(() => refreshWindowState());
}

function winToggleAlwaysOnTop(): void {
  winAlwaysOnTop.value = !winAlwaysOnTop.value;
  void getCurrentWindow().setAlwaysOnTop(winAlwaysOnTop.value);
}

function winToggleFullscreen(): void {
  winFullscreen.value = !winFullscreen.value;
  void getCurrentWindow().setFullscreen(winFullscreen.value);
}

function winCenter(): void {
  void getCurrentWindow().center();
}

/** 重载 WebView 内容（开发期刷新界面状态） */
function reloadWebview(): void {
  location.reload();
}

// ---------------------------------------------------------------------------
// 开发者服务·项目操作：项目目录 / 资产统计 / 元数据补齐
// ---------------------------------------------------------------------------

const devBusy = ref(false);
/** 资产统计结果文本（扫描后填充） */
const assetStats = ref("");

async function revealProject(): Promise<void> {
  const root = projectStore.currentPath;
  if (!root) return;
  try {
    await revealItemInDir(root);
  } catch (e) {
    console.error("打开项目目录失败:", e);
    alert("打开项目目录失败：" + e);
  }
}

async function scanProjectAssets(): Promise<void> {
  const root = projectStore.currentPath;
  if (!root) return;
  devBusy.value = true;
  try {
    const list = await api.scanAssets(root);
    const counts = new Map<string, number>();
    for (const e of list) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    assetStats.value =
      `共 ${list.length} 项 · ` +
      [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([kind, n]) => `${kind} ${n}`)
        .join(" · ");
  } catch (e) {
    assetStats.value = "";
    alert("扫描资产失败：" + e);
  } finally {
    devBusy.value = false;
  }
}

async function fillProjectMeta(): Promise<void> {
  const root = projectStore.currentPath;
  if (!root) return;
  devBusy.value = true;
  try {
    await api.ensureProjectMeta(root);
    alert("已为缺失 .meta 的资产补齐元数据。");
  } catch (e) {
    alert("补齐元数据失败：" + e);
  } finally {
    devBusy.value = false;
  }
}

// ---------------------------------------------------------------------------
// 开发者服务·命令操作：快捷调试命令 + 自由命令执行器 + 输出区
// ---------------------------------------------------------------------------

const cmdOutput = ref<string[]>([]);

function logCmd(line: string): void {
  cmdOutput.value.unshift(`[${new Date().toLocaleTimeString()}] ${line}`);
  if (cmdOutput.value.length > 30) cmdOutput.value.pop();
}

/** 执行一条 Tauri 命令，结果/错误追加到输出区（长结果截断显示） */
async function runCmd(name: string, args?: Record<string, unknown>): Promise<unknown> {
  try {
    const r = await invoke(name, args);
    let text = "";
    if (r !== undefined) {
      text = JSON.stringify(r);
      if (text.length > 400) text = `${text.slice(0, 400)}…(共 ${text.length} 字符)`;
    }
    logCmd(`${name} → 成功${text ? `: ${text}` : ""}`);
    return r;
  } catch (e) {
    logCmd(`${name} → 失败: ${String(e)}`);
    return undefined;
  }
}

function runSceneDirty(): void {
  void runCmd("scene_dirty");
}

function runSceneSave(): void {
  void runCmd("scene_save");
}

function runScanInternal(): void {
  void runCmd("scan_internal_assets");
}

function runStartPreview(): void {
  const root = projectStore.currentPath;
  if (!root) {
    logCmd("start_web_preview_server → 失败: 未打开项目");
    return;
  }
  void runCmd("start_web_preview_server", { root });
}

function runStopPreview(): void {
  void runCmd("stop_web_preview");
}

/** 自由命令执行器（命令名 + JSON 参数；键与后端命令签名一致） */
const customCmd = ref("");
const customArgs = ref("{}");

async function runCustom(): Promise<void> {
  const name = customCmd.value.trim();
  if (!name) return;
  let args: Record<string, unknown> | undefined;
  const raw = customArgs.value.trim();
  if (raw) {
    try {
      args = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      logCmd(`${name} → 参数 JSON 解析失败: ${raw}`);
      return;
    }
  }
  await runCmd(name, args);
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

        <!-- ========== 开发者服务 ========== -->
        <section v-if="section === 'dev'" class="page">
          <div class="page-head">
            <div>
              <h2>开发者服务</h2>
              <p class="sub">调试工具、运行信息与开发文档</p>
            </div>
          </div>

          <!-- 运行环境 -->
          <div class="settings-card">
            <h3>运行环境</h3>
            <div class="about-row">
              <span>应用版本</span>
              <span class="dim">v0.1.0</span>
            </div>
            <div class="about-row">
              <span>运行环境</span>
              <span class="dim">
                {{ inTauri ? `Tauri${tauriVersion ? ` · ${tauriVersion}` : ""}` : "浏览器（无桌面后端）" }}
              </span>
            </div>
            <div class="about-row">
              <span>渲染引擎</span>
              <span class="dim">three.js r{{ threeRevision }}</span>
            </div>
            <div class="about-row">
              <span>界面框架</span>
              <span class="dim">Vue {{ vueVersion }}</span>
            </div>
          </div>

          <!-- 桌面客户端：窗口操作 / WebView / 应用目录 -->
          <div class="settings-card">
            <h3>桌面客户端</h3>
            <template v-if="inTauri">
              <div class="set-row">
                <label>窗口</label>
                <div class="dev-btn-row">
                  <button @click="winMinimize">最小化</button>
                  <button @click="winToggleMaximize">
                    {{ winMaximized ? "还原窗口" : "最大化窗口" }}
                  </button>
                  <button @click="winToggleAlwaysOnTop">
                    {{ winAlwaysOnTop ? "取消置顶" : "窗口置顶" }}
                  </button>
                  <button @click="winToggleFullscreen">
                    {{ winFullscreen ? "退出全屏" : "进入全屏" }}
                  </button>
                  <button @click="winCenter">窗口居中</button>
                </div>
              </div>
              <div class="set-row">
                <label>WebView</label>
                <div class="dev-btn-row">
                  <button @click="reloadWebview">重新加载界面</button>
                  <button @click="openDevtools">打开 DevTools</button>
                  <button @click="writeTestDebugLog">写入测试日志</button>
                </div>
              </div>
              <p class="hint">
                调试日志写入应用配置目录下的 debug.log，WebView 白屏时也可用于排查。
              </p>
              <div v-for="[name, p] in appDirs" :key="name" class="dev-dir-row">
                <span class="dev-dir-name">{{ name }}</span>
                <span class="dev-dir-path mono" :title="p">{{ p }}</span>
                <button @click="openDir(p)">打开</button>
              </div>
            </template>
            <p v-else class="hint">
              当前为浏览器直开环境，桌面客户端操作不可用；需在 Tauri 应用内使用。
            </p>
          </div>

          <!-- 项目操作：目录 / 资产统计 / 元数据 -->
          <div class="settings-card">
            <h3>项目操作</h3>
            <template v-if="projectStore.currentPath">
              <div class="set-row">
                <label>当前项目</label>
                <span class="dev-dir-path mono" :title="projectStore.currentPath">
                  {{ projectStore.projectName }} · {{ projectStore.currentPath }}
                </span>
                <button @click="revealProject">打开目录</button>
              </div>
              <div class="set-row">
                <label>资产统计</label>
                <div class="dev-btn-row">
                  <button :disabled="devBusy" @click="scanProjectAssets">扫描资产</button>
                </div>
              </div>
              <p v-if="assetStats" class="hint mono">{{ assetStats }}</p>
              <div class="set-row">
                <label>元数据</label>
                <div class="dev-btn-row">
                  <button :disabled="devBusy" @click="fillProjectMeta">补齐缺失 .meta</button>
                </div>
              </div>
              <p class="hint">只补建缺失的 .meta 文件（uuid/引用映射），不改动已有元数据。</p>
            </template>
            <p v-else class="hint">尚未打开项目；先在「项目」页打开或新建一个项目。</p>
          </div>

          <!-- 命令操作：快捷调试命令 + 自由命令执行器 -->
          <div class="settings-card">
            <h3>命令操作</h3>
            <div class="dev-btn-row">
              <button @click="runSceneDirty">查询场景脏状态</button>
              <button @click="runSceneSave">保存场景会话</button>
              <button @click="runScanInternal">扫描内置资产</button>
              <button @click="runStartPreview">启动预览服务器</button>
              <button @click="runStopPreview">停止预览服务器</button>
            </div>
            <div class="set-row dev-custom-cmd">
              <input
                v-model="customCmd"
                placeholder="命令名，如 scan_assets"
                spellcheck="false"
                @keydown.enter="runCustom"
              />
              <input
                v-model="customArgs"
                placeholder='参数 JSON，如 {"root":"C:/proj"}'
                spellcheck="false"
                @keydown.enter="runCustom"
              />
              <button @click="runCustom">执行</button>
            </div>
            <div class="dev-cmd-out-head">
              <span>输出（最近 {{ cmdOutput.length }} 条）</span>
              <button @click="cmdOutput = []">清空</button>
            </div>
            <pre class="dev-cmd-output">{{ cmdOutput.join("\n") || "—" }}</pre>
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

    <NewProjectDialog
      v-if="showNewProject"
      @close="closeNewProject"
      @created="handleProjectCreated"
    />
  </div>
</template>