<script setup lang="ts">
/**
 * 底部停靠·「资产」（编辑器资产面板同构复刻）：
 * - 数据直接使用编辑器的 assets store（同一份扫描/刷新链路，数据完全一致）；
 * - 工具栏/条目单元格复用编辑器的 AssetToolbar / AssetEntryCell 真件，
 *   样式复用 assets-panel.scss（面包屑/搜索/类型筛选/排序/视图切换）；
 * - 文件夹树为只读复刻（无重命名/删除等编辑器动作，避免跨窗口操作场景会话）；
 * - 双击场景资产 = 打开该场景（切当前场景，层级/实体/脚本图随之切换）。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { getAssetsStore } from "../../app/stores/assets";
import AssetToolbar from "../../app/components/AssetToolbar.vue";
import AssetEntryCell from "../../app/components/AssetEntryCell.vue";
import {
  listDirectoryChildren,
  type ChildEntry,
} from "../../app/lib/asset-browser";
import { getGraphWindowStore } from "../graphStore";
import "../../styles/components/assets-panel.scss";

const store = getGraphWindowStore();
const assetsStore = getAssetsStore();

// ----- 导航/视图状态（与编辑器资产面板同款交互） -----
const currentDir = ref("");
const backStack = ref<string[]>([]);
const fwdStack = ref<string[]>([]);
const query = ref("");
const typeFilter = ref("all");
const sortBy = ref("name");
const viewMode = ref<"grid" | "list">("grid");
const selectedPath = ref("");

interface DirNode {
  name: string;
  path: string;
  children: DirNode[];
}

/** 路径逐段装配目录树（与编辑器 AssetsPanel 的树构建完全一致） */
const dirTree = computed<DirNode[]>(() => {
  const tree: DirNode[] = [];
  for (const a of assetsStore.assets) {
    const parts = a.path.split("/");
    let cursor = tree;
    let curPath = "";
    for (let i = 0; i < parts.length; i++) {
      curPath = curPath ? `${curPath}/${parts[i]}` : parts[i];
      const isLast = i === parts.length - 1;
      let node = cursor.find((c) => c.name === parts[i]);
      if (!node) {
        node = { name: parts[i], path: curPath, children: [] };
        cursor.push(node);
      }
      if (!isLast) cursor = node.children;
    }
  }
  return tree;
});

const collapsed = ref(new Set<string>());
let collapseTimer: ReturnType<typeof setTimeout> | null = null;

// 折叠态按窗口持久化（键含 graph 前缀与编辑器隔离；键 = 项目根）
const collapseKey = computed(() => `three-visual-editor:graph-asset-tree:v1:${store.root ?? ""}`);
function loadCollapsedDirs(): void {
  if (collapseTimer != null) {
    clearTimeout(collapseTimer);
    collapseTimer = null;
  }
  try {
    const raw = localStorage.getItem(collapseKey.value);
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    collapsed.value = new Set(
      Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [],
    );
  } catch {
    collapsed.value = new Set();
  }
}
function persistCollapsedDirs(): void {
  if (collapseTimer != null) clearTimeout(collapseTimer);
  collapseTimer = setTimeout(() => {
    collapseTimer = null;
    try {
      localStorage.setItem(collapseKey.value, JSON.stringify([...collapsed.value]));
    } catch {
      /* 存储不可用：折叠态仅本次会话有效 */
    }
  }, 300);
}
watch(collapseKey, loadCollapsedDirs, { immediate: true });

// 过滤状态（搜索/类型/排序/视图）从编辑器资产面板同步（共享键只读，编辑器为写入方）
const filterKey = computed(() => `three-visual-editor:graph-asset-filter:v1:${store.root ?? ""}`);
function loadFilter(): void {
  try {
    const raw = localStorage.getItem(filterKey.value);
    if (!raw) return;
    const f = JSON.parse(raw) as Record<string, unknown>;
    if (typeof f.query === "string") query.value = f.query;
    if (typeof f.typeFilter === "string") typeFilter.value = f.typeFilter;
    if (typeof f.sortBy === "string") sortBy.value = f.sortBy;
    if (f.viewMode === "grid" || f.viewMode === "list") viewMode.value = f.viewMode;
  } catch {
    /* ignore */
  }
}
function onStorage(e: StorageEvent): void {
  if (e.key === filterKey.value) loadFilter();
}
function onWindowFocus(): void {
  loadFilter();
}

function toggleDir(path: string): void {
  const next = new Set(collapsed.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  collapsed.value = next;
  persistCollapsedDirs();
}

/** 树行扁平化（折叠过滤） */
const treeRows = computed(() => {
  const rows: { node: DirNode; depth: number }[] = [];
  const walk = (nodes: DirNode[], depth: number): void => {
    for (const n of nodes) {
      rows.push({ node: n, depth });
      if (n.children.length && !collapsed.value.has(n.path)) walk(n.children, depth + 1);
    }
  };
  walk(dirTree.value, 0);
  return rows;
});

const crumbs = computed(() => {
  const crumbs: { name: string; path: string }[] = [{ name: "项目", path: "" }];
  if (currentDir.value) {
    const parts = currentDir.value.split("/");
    for (let i = 0; i < parts.length; i++) {
      crumbs.push({ name: parts[i], path: parts.slice(0, i + 1).join("/") });
    }
  }
  return crumbs;
});

const children = computed(() =>
  listDirectoryChildren(assetsStore.assets, currentDir.value, query.value, typeFilter.value, sortBy.value),
);

function navigate(path: string): void {
  if (path === currentDir.value) return;
  backStack.value.push(currentDir.value);
  fwdStack.value = [];
  currentDir.value = path;
}

function goBack(): void {
  const prev = backStack.value.pop();
  if (prev === undefined) return;
  fwdStack.value.push(currentDir.value);
  currentDir.value = prev;
}

function goForward(): void {
  const next = fwdStack.value.pop();
  if (next === undefined) return;
  backStack.value.push(currentDir.value);
  currentDir.value = next;
}

function goUp(): void {
  if (!currentDir.value) return;
  navigate(currentDir.value.includes("/") ? currentDir.value.slice(0, currentDir.value.lastIndexOf("/")) : "");
}

async function refresh(): Promise<void> {
  await assetsStore.refresh();
}

function onEntryClick(item: ChildEntry): void {
  selectedPath.value = item.path;
}

/** 双击：场景资产 = 打开该场景（与编辑器双击场景一致）；其余类型暂无对应工作台 */
function onEntryDblclick(item: ChildEntry): void {
  if (item.kind === "dir") {
    navigate(item.path);
    return;
  }
  if (item.kind === "scene") {
    void store.openScene(item.path);
  }
}

onMounted(() => {
  // 数据与编辑器同源：装载失败留给装载蒙版阶段提示（assets 阶段已 load）
  if (store.root && !assetsStore.assets.length) void assetsStore.load(store.root);
  // 过滤状态跟随编辑器资产面板（storage 事件 + 聚焦时兜底刷新）
  loadFilter();
  window.addEventListener("storage", onStorage);
  window.addEventListener("focus", onWindowFocus);
});
onUnmounted(() => {
  window.removeEventListener("storage", onStorage);
  window.removeEventListener("focus", onWindowFocus);
});
</script>

<template>
  <div class="asset-manager assets">
    <AssetToolbar
      :back-enabled="backStack.length > 0"
      :forward-enabled="fwdStack.length > 0"
      :up-enabled="currentDir !== ''"
      :crumbs="crumbs"
      :query="query"
      :type-filter="typeFilter"
      :sort-by="sortBy"
      :view-mode="viewMode"
      :can-import="false"
      @back="goBack"
      @forward="goForward"
      @up="goUp"
      @navigate="navigate"
      @update:query="query = $event"
      @update:type-filter="typeFilter = $event"
      @update:sort-by="sortBy = $event"
      @update:view-mode="viewMode = $event"
      @refresh="refresh"
    />

    <div class="am-body">
      <div class="am-tree">
        <div
          v-for="{ node, depth } in treeRows"
          :key="node.path"
          class="gtree-row"
          :class="{ active: node.path === currentDir }"
          :style="{ paddingLeft: 6 + depth * 12 + 'px' }"
          :title="node.path"
          @click="navigate(node.path)"
          @dblclick="toggleDir(node.path)"
        >
          <span class="arrow" @click.stop="toggleDir(node.path)">{{
            node.children.length ? (collapsed.has(node.path) ? "▸" : "▾") : ""
          }}</span>
          <span class="name">{{ node.name }}</span>
        </div>
      </div>
      <div class="am-content" :class="'view-' + viewMode" @click="selectedPath = ''">
        <AssetEntryCell
          v-for="item in children"
          :key="item.path"
          :item="item"
          :view="viewMode"
          :selected="selectedPath === item.path"
          :drop-over="false"
          @click="onEntryClick(item)"
          @dblclick="onEntryDblclick(item)"
        />
        <div v-if="!children.length" class="am-empty">当前目录没有资产</div>
      </div>
    </div>
    <div class="gpanel-tip">双击场景资产打开（层级/实体/脚本图随之切换）</div>
  </div>
</template>
