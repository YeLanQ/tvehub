<script setup lang="ts">
// ---------------------------------------------------------------------------
// 助手面板（两栏）：左 = 项目工作区（通用 + 最近项目 + 设置入口），
// 右 = 聊天 / 设置就地切换。窗口无边框：顶部细条为拖拽区 + 关闭（隐藏）。
// 工作区语义：项目目录即工作区——点击仅切换对话与资产上下文，不需要在编辑器
// 打开项目；读改资产经 devtools 的 root 覆盖直达文件系统。
// 项目清单永远只读自项目管理页（最近项目，project.list），面板不提供增删入口。
// ---------------------------------------------------------------------------
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../lib/tauri-env";
import { uiStateGet, uiStateSet } from "../lib/ui-state";
import { api } from "../lib/api";
import { ToastHost, toastErr, toastOk } from "../ui-kit";
import { getConversations, type ConvMeta } from "./conversations";

interface ProjectRow {
  path: string;
  name: string;
  sceneCount?: number;
}

const convs = getConversations();

const settingsOpen = ref(false);
const projects = ref<ProjectRow[]>([]);
const editorProject = ref<string | null>(null);
/** 收起的会话树（按工作区根；默认展开；持久化跨应用重启记忆） */
const folded = ref<Set<string>>(new Set());
/** 折叠状态持久化键（与会话索引同走 ui-state KV） */
const KEY_FOLDED = "tve:ai:rail-folded";

const activeRoot = computed(() => convs.activeRoot);

onMounted(async () => {
  const savedFolded = await uiStateGet<string[]>(KEY_FOLDED);
  if (Array.isArray(savedFolded)) folded.value = new Set(savedFolded);
  await convs.load();
  await convs.switchProject(convs.activeRoot);
  void refreshProjects();
  void refreshEditorState();
  if (isTauri()) {
    // 项目列表跨窗口同步：助手内建项目 / 首页与控制端增删改项目 → projects:changed
    // 广播后即时重扫（防抖：一次操作可能连发多次广播）
    void listen("projects:changed", () => {
      clearTimeout(rescanTimer);
      rescanTimer = setTimeout(() => {
        void refreshProjects();
        void refreshEditorState();
      }, 300);
    }).then((off) => (offProjectsChanged = off));
  }
});

/** 项目列表外部变更防抖（同 HomeView 口径） */
let rescanTimer: ReturnType<typeof setTimeout> | undefined;
let offProjectsChanged: (() => void) | undefined;

onBeforeUnmount(() => {
  offProjectsChanged?.();
  clearTimeout(rescanTimer);
});

/** 会话树折叠：点工作区卡左侧文件夹图标收起/展开其会话叶 */
function isFolded(root: string): boolean {
  return folded.value.has(root);
}

function toggleFold(root: string): void {
  const next = new Set(folded.value);
  if (next.has(root)) next.delete(root);
  else next.add(root);
  folded.value = next;
  // 即时持久化（fire-and-forget；重启后左栏恢复同样的折叠状态）
  void uiStateSet(KEY_FOLDED, [...next]);
}

/** 模板用：折叠的工作区不渲染会话叶 */
function visibleConvs(root: string): ConvMeta[] {
  return isFolded(root) ? [] : convs.convsOf(root);
}

async function callDevtools(
  method: string,
  params?: Record<string, unknown>,
  silent = false,
) {
  try {
    return await api.devtoolsCall(method, params);
  } catch (e) {
    // silent = 后台探查/刷新（挂载首扫、projects:changed 重扫）：无编辑器窗口
    // 或开发者服务未开是常态，失败只落状态不弹错；用户主动操作才 toast
    if (!silent) toastErr(e instanceof Error ? e.message : String(e));
    return null;
  }
}

async function refreshProjects(): Promise<void> {
  // devtools project.list 返回 { recent: [{path,name,sceneCount}] }
  const doc = (await callDevtools("project.list", undefined, true)) as {
    recent?: ProjectRow[];
  } | null;
  projects.value = Array.isArray(doc?.recent) ? doc.recent : [];
}

async function refreshEditorState(): Promise<void> {
  const st = await callDevtools("editor.state", undefined, true);
  const path =
    st && typeof st === "object"
      ? (st as Record<string, unknown>).currentPath
      : null;
  editorProject.value = typeof path === "string" && path ? path : null;
}

/** 进入工作区：只切换对话/资产上下文，不启动编辑器 */
async function pickWorkspace(path: string): Promise<void> {
  await convs.switchProject(path);
  settingsOpen.value = false;
}

/** 点击会话叶：必要时切工作区，再激活该会话 */
async function openConv(root: string, convId: string): Promise<void> {
  if (activeRoot.value !== root) {
    await convs.switchProject(root);
    settingsOpen.value = false;
  }
  await convs.selectConv(root, convId);
}

/** 删除某个工作区的会话；若删的是激活会话，watch 会自动落到剩余会话或新建 */
function deleteConv(root: string, convId: string): void {
  convs.remove(root, convId);
}

/** 在该工作区新建会话并切换过去（不打开编辑器） */
async function newConvIn(path: string): Promise<void> {
  await convs.switchProject(path);
  await convs.newConversation(path);
  settingsOpen.value = false;
  toastOk(`已新建会话（${path || "通用"}）`);
}

// ---------------------------------------------------------------------------
// 浮动文件树：项目条目悬停 →「展开文件」→ 面板从右滑出（覆盖聊天，可关闭）。
// 数据 = asset.list(root) 的扁平清单 → 前端组树；点文件经事件插入聊天输入框。
// ---------------------------------------------------------------------------
interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  children: TreeNode[];
}
interface TreeRow {
  node: TreeNode;
  depth: number;
}

const treeOpen = ref(false);
const treeLoading = ref(false);
const treeName = ref("");
const treeRoot = ref("");
const treeNodes = ref<TreeNode[]>([]);
const treeExpanded = ref<Set<string>>(new Set());

function buildTree(entries: Array<{ path: string; kind: string }>): TreeNode[] {
  const root: TreeNode = { name: "", path: "", dir: true, children: [] };
  for (const e of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!e.path) continue;
    const parts = e.path.split("/");
    let cur = root;
    let acc = "";
    for (let i = 0; i < parts.length; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      const isLeaf = i === parts.length - 1;
      let child = cur.children.find((c) => c.name === parts[i]);
      if (!child) {
        child = {
          name: parts[i],
          path: acc,
          dir: isLeaf ? e.kind === "dir" : true,
          children: [],
        };
        cur.children.push(child);
      }
      cur = child;
    }
  }
  const sortRec = (n: TreeNode): void => {
    n.children.sort((a, b) =>
      a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1,
    );
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root.children;
}

async function openTree(p: ProjectRow): Promise<void> {
  treeName.value = p.name;
  treeRoot.value = p.path;
  treeOpen.value = true;
  treeLoading.value = true;
  try {
    const list = await api.devtoolsCall("asset.list", { root: p.path });
    treeNodes.value = buildTree(Array.isArray(list) ? list : []);
    // 默认展开第一层目录
    treeExpanded.value = new Set(
      treeNodes.value.filter((n) => n.dir).map((n) => n.path),
    );
  } catch (e) {
    toastErr(e instanceof Error ? e.message : String(e));
    treeOpen.value = false;
  } finally {
    treeLoading.value = false;
  }
}

const treeRows = computed(() => {
  const out: TreeRow[] = [];
  const walk = (nodes: TreeNode[], depth: number): void => {
    for (const n of nodes) {
      out.push({ node: n, depth });
      if (n.dir && treeExpanded.value.has(n.path)) walk(n.children, depth + 1);
    }
  };
  walk(treeNodes.value, 0);
  return out;
});

function toggleDir(node: TreeNode): void {
  const next = new Set(treeExpanded.value);
  if (next.has(node.path)) next.delete(node.path);
  else next.add(node.path);
  treeExpanded.value = next;
}

/** 点文件：插入 @路径 引用（内容在发送时才按需解析） */
async function treeOpenFile(node: TreeNode): Promise<void> {
  window.dispatchEvent(
    new CustomEvent("assistant:insert-file", {
      detail: { path: node.path },
    }),
  );
}

function toggleWindow(): void {
  if (!isTauri()) return;
  convs.flush();
  void getCurrentWindow().hide();
}

defineExpose({ refreshProjects, refreshEditorState });
</script>

<template>
  <div class="assistant">
    <div class="assistant-chrome" data-tauri-drag-region>
      <span class="assistant-chrome-title" data-tauri-drag-region>TvE 助手</span>
      <button class="assistant-chrome-close" title="隐藏（状态保留）" @click="toggleWindow">×</button>
    </div>
    <div class="assistant-body">
      <!-- 左栏：项目工作区 -->
      <aside class="assistant-rail">
        <div
          class="assistant-rail-itemwrap"
          :class="{ active: activeRoot === '' }"
        >
          <button
            class="assistant-rail-fold"
            :title="isFolded('') ? '展开会话' : '收起会话'"
            @click="toggleFold('')"
          >
            <svg v-if="isFolded('')" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round">
              <path d="M2.2 4.4c0-.66.54-1.2 1.2-1.2h2.8c.37 0 .72.17.95.46l.75.94h4.1c.66 0 1.2.54 1.2 1.2v5.8c0 .66-.54 1.2-1.2 1.2H3.4a1.2 1.2 0 0 1-1.2-1.2V4.4z" />
            </svg>
            <svg v-else viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round">
              <path d="M2.2 11.4V4.4c0-.66.54-1.2 1.2-1.2h2.8c.37 0 .72.17.95.46l.75.94h4.1c.66 0 1.2.54 1.2 1.2v1.5" />
              <path d="M2.3 11.5l1.6-3.2c.2-.4.61-.66 1.06-.66h8.14c.63 0 1.06.62.86 1.2l-.95 2.86c-.17.48-.62.8-1.13.8H3.5a1.2 1.2 0 0 1-1.2-1z" />
            </svg>
          </button>
          <button
            class="assistant-rail-item"
            title="未打开项目的通用对话"
            @click="pickWorkspace('')"
          >
            通用
          </button>
          <span class="assistant-rail-acts">
            <button title="新建会话" @click="newConvIn('')">
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
                <path d="M8 3.2v9.6" />
                <path d="M3.2 8h9.6" />
              </svg>
            </button>
          </span>
        </div>
        <!-- 通用工作区的会话叶 -->
        <div
          v-for="c in visibleConvs('')"
          :key="c.id"
          class="assistant-rail-leaf"
          :class="{ active: activeRoot === '' && convs.activeConvIdOf('') === c.id }"
          :title="c.title"
          @click="openConv('', c.id)"
        >
          <span class="assistant-rail-leaf-mark">·</span>
          <span class="assistant-rail-leaf-title">{{ c.title }}</span>
          <span
            class="assistant-rail-leaf-x"
            title="删除会话"
            @click.stop="deleteConv('', c.id)"
          >×</span>
        </div>
        <div class="assistant-rail-sep">项目工作区</div>
        <div class="assistant-rail-list">
          <template v-for="p in projects" :key="p.path">
            <div
              class="assistant-rail-itemwrap"
              :class="{ active: activeRoot === p.path }"
            >
              <button
                class="assistant-rail-fold"
                :title="isFolded(p.path) ? '展开会话' : '收起会话'"
                @click="toggleFold(p.path)"
              >
                <svg v-if="isFolded(p.path)" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round">
                  <path d="M2.2 4.4c0-.66.54-1.2 1.2-1.2h2.8c.37 0 .72.17.95.46l.75.94h4.1c.66 0 1.2.54 1.2 1.2v5.8c0 .66-.54 1.2-1.2 1.2H3.4a1.2 1.2 0 0 1-1.2-1.2V4.4z" />
                </svg>
                <svg v-else viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round">
                  <path d="M2.2 11.4V4.4c0-.66.54-1.2 1.2-1.2h2.8c.37 0 .72.17.95.46l.75.94h4.1c.66 0 1.2.54 1.2 1.2v1.5" />
                  <path d="M2.3 11.5l1.6-3.2c.2-.4.61-.66 1.06-.66h8.14c.63 0 1.06.62.86 1.2l-.95 2.86c-.17.48-.62.8-1.13.8H3.5a1.2 1.2 0 0 1-1.2-1z" />
                </svg>
              </button>
              <button
                class="assistant-rail-item"
                :title="p.path"
                @click="pickWorkspace(p.path)"
              >
                <span class="assistant-rail-name">
                  <span class="assistant-rail-dot" v-if="editorProject === p.path" />
                  {{ p.name }}
                </span>
                <span class="assistant-rail-meta">{{ p.sceneCount ?? 0 }} 场景</span>
              </button>
              <span class="assistant-rail-acts">
                <button title="展开文件" @click="openTree(p)">
                  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="2.6" y="2.6" width="4.8" height="4.8" rx="1" />
                    <path d="M5 7.4V12a2 2 0 0 0 2 2h2.2" />
                    <path d="M9.6 6.2h4.4" />
                    <path d="M9.6 10h4.4" />
                    <path d="M9.6 13.8h4.4" />
                  </svg>
                </button>
                <button title="新建会话" @click="newConvIn(p.path)">
                  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
                    <path d="M8 3.2v9.6" />
                    <path d="M3.2 8h9.6" />
                  </svg>
                </button>
              </span>
            </div>
            <!-- 该项目的会话叶（点文件夹图标可收起） -->
            <div
              v-for="c in visibleConvs(p.path)"
              :key="c.id"
              class="assistant-rail-leaf"
              :class="{ active: activeRoot === p.path && convs.activeConvIdOf(p.path) === c.id }"
              :title="c.title"
              @click="openConv(p.path, c.id)"
            >
              <span class="assistant-rail-leaf-mark">·</span>
              <span class="assistant-rail-leaf-title">{{ c.title }}</span>
              <span
                class="assistant-rail-leaf-x"
                title="删除会话"
                @click.stop="deleteConv(p.path, c.id)"
              >×</span>
            </div>
          </template>
          <p v-if="!projects.length" class="assistant-rail-empty">
            暂无项目：在首页项目管理页添加
          </p>
        </div>
        <button
          class="assistant-rail-settings"
          :class="{ open: settingsOpen }"
          title="智能体卡片与供应商设置"
          @click="settingsOpen = !settingsOpen"
        >
          ⚙ 设置
        </button>
      </aside>

      <!-- 右栏：聊天 / 设置。v-show 而非 v-if：设置面板打开时聊天组件必须
           保持实例——v-if 会销毁 AssistantChat，运行中的任务虽在闭包里继续，
           却失去全部视图与停止/确认入口，重挂载还会让同一会话并发开第二个
           任务 -->
      <section class="assistant-main">
        <AssistantSettings v-show="settingsOpen" @close="settingsOpen = false" />
        <AssistantChat v-show="!settingsOpen" />
      </section>
    </div>
      <!-- 浮动文件树：从右滑出 -->
      <transition name="tree-slide">
        <aside v-if="treeOpen" class="assistant-tree">
          <div class="assistant-tree-head">
            <span class="assistant-tree-title">文件 · {{ treeName }}</span>
            <button class="assistant-tree-close" title="收起" @click="treeOpen = false">×</button>
          </div>
          <p v-if="treeLoading" class="assistant-tree-empty">读取中…</p>
          <p v-else-if="!treeRows.length" class="assistant-tree-empty">空项目</p>
          <div v-else class="assistant-tree-body">
            <button
              v-for="row in treeRows"
              :key="row.node.path"
              class="assistant-tree-row"
              :class="{ dir: row.node.dir }"
              :style="{ paddingLeft: 8 + row.depth * 14 + 'px' }"
              @click="row.node.dir ? toggleDir(row.node) : treeOpenFile(row.node)"
            >
              <span class="assistant-tree-ico">{{ row.node.dir ? (treeExpanded.has(row.node.path) ? "▾" : "▸") : "·" }}</span>
              {{ row.node.name }}
            </button>
          </div>
          <p class="assistant-tree-tip">点文本文件 → 插入到输入框</p>
        </aside>
      </transition>
      <ToastHost />
  </div>
</template>

<script lang="ts">
import AssistantChat from "./AssistantChat.vue";
import AssistantSettings from "./AssistantSettings.vue";
export default { components: { AssistantChat, AssistantSettings } };
</script>

<style scoped lang="scss">
.assistant {
  display: flex;
  flex-direction: column;
  height: 100vh;
  position: relative;
  background: var(--bg-panel);
  color: var(--text);
  font: 13px/1.5 system-ui, "Segoe UI", sans-serif;
  user-select: none;
}
.assistant-chrome {
  display: flex;
  align-items: center;
  height: 30px;
  flex: none;
  background: var(--bg-panel-2);
  -webkit-app-region: drag;
  .assistant-chrome-title {
    padding: 0 10px;
    font-size: 12px;
    color: var(--text-dim);
  }
  .assistant-chrome-close {
    margin-left: auto;
    margin-right: 4px;
    width: 26px;
    height: 22px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    -webkit-app-region: no-drag;
    border: none;
    background: transparent;
    color: var(--text-dim);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    &:hover { background: var(--bg-hover); color: var(--text); }
  }
}
.assistant-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.assistant-rail {
  display: flex;
  flex-direction: column;
  width: 200px;
  flex: none;
  border-right: 1px solid var(--border);
  background: var(--bg);
  padding: 8px 6px;
  gap: 2px;
}
.assistant-rail-item {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 1px;
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border: none;
  border-radius: 0 6px 6px 0;
  background: transparent;
  color: var(--text-dim);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  &:hover { background: var(--bg-hover); color: var(--text); }
  &.active { background: var(--bg-active); color: var(--text); }
}
.assistant-rail-name {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.assistant-rail-meta {
  font-size: 11px;
  color: var(--text-dim);
  opacity: 0.8;
}
.assistant-rail-dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--ok);
}
.assistant-rail-itemwrap {
  position: relative;
  display: flex;
  align-items: stretch;
  &.active .assistant-rail-item { background: var(--bg-active); color: var(--text); }
  &.active .assistant-rail-fold { background: var(--bg-active); color: var(--text); }
  /* 文件夹折叠钮：点它收起/展开该工作区的会话叶（展开=开口文件夹，收起=闭合） */
  .assistant-rail-fold {
    flex: none;
    width: 24px;
    padding: 0; /* 全局 button 基础样式带 4px/11px 内边距，固定尺寸钮必须清零 */
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 6px 0 0 6px;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    svg { flex: none; }
    &:hover { background: var(--bg-hover); color: var(--text); }
  }
  /* 悬停显示操作钮（展开文件 / 编辑器打开），盖在条目右侧 */
  .assistant-rail-acts {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    display: none;
    gap: 2px;
  }
  &:hover .assistant-rail-acts { display: flex; }
  .assistant-rail-acts button {
    width: 22px;
    height: 20px;
    padding: 0; /* 全局 button 基础样式带 4px/11px 内边距，会把固定尺寸按钮的内容盒挤没 */
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--bg-panel);
    color: var(--text-dim);
    cursor: pointer;
    &:hover { background: var(--bg-hover); color: var(--text); }
  }
}
.assistant-tree {
  position: absolute;
  top: 36px;
  right: 8px;
  width: 264px;
  /* 收敛：高度随内容自适应，封顶约 60% 窗高，内部滚动 */
  max-height: min(60vh, 480px);
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.4);
  z-index: 20;
  overflow: hidden;
  user-select: text;
}
.tree-slide-enter-active,
.tree-slide-leave-active { transition: transform 0.22s ease, opacity 0.22s ease; }
.tree-slide-enter-from,
.tree-slide-leave-to { transform: translateX(100%); opacity: 0.4; }
.assistant-tree-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  flex: none;
  .assistant-tree-title { font-size: 12px; color: var(--text); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .assistant-tree-close { border: none; background: transparent; color: var(--text-dim); font-size: 14px; cursor: pointer;
    &:hover { color: var(--text); } }
}
.assistant-tree-body { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 4px; }
.assistant-tree-row {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  border: none;
  background: transparent;
  color: var(--text-dim);
  border-radius: 5px;
  padding: 3px 6px;
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  .assistant-tree-ico { flex: none; width: 12px; color: var(--accent); }
  &:hover { background: var(--bg-hover); color: var(--text); }
  &.dir { color: var(--text); }
}
.assistant-tree-empty { margin: 10px; font-size: 12px; color: var(--text-dim); }
.assistant-tree-tip { flex: none; margin: 0; padding: 6px 10px; border-top: 1px solid var(--border); font-size: 11px; color: var(--text-dim); }
.assistant-rail-sep {
  margin: 8px 8px 2px;
  font-size: 11px;
  color: var(--text-dim);
}
/* 会话叶：目录下的会话条目（缩进对齐工作区名，即文件夹图标之后） */
.assistant-rail-leaf {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0 6px 1px 30px;
  padding: 4px 6px;
  border-radius: 5px;
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
  overflow: hidden;
  &:hover { background: var(--bg-hover); color: var(--text); }
  &.active { background: var(--bg-active); color: var(--text); }
}
.assistant-rail-leaf-mark {
  flex: none;
  color: var(--accent);
}
.assistant-rail-leaf-title {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.assistant-rail-leaf-x {
  flex: none;
  width: 16px;
  height: 16px;
  display: none;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  font-size: 12px;
  .assistant-rail-leaf:hover & { display: inline-flex; }
  &:hover { background: var(--err); color: #fff; }
}
.assistant-rail-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.assistant-rail-empty {
  margin: 4px 8px;
  font-size: 12px;
  color: var(--text-dim);
}
.assistant-rail-settings {
  flex: none;
  margin-top: 6px;
  padding: 7px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--btn);
  color: var(--text-dim);
  cursor: pointer;
  &:hover { background: var(--btn-hover); color: var(--text); }
  &.open { background: var(--bg-active); color: var(--text); border-color: var(--accent); }
}
.assistant-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
</style>
