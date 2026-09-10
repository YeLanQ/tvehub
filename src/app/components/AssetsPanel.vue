<script setup lang="ts">
/**
 * 资产面板（双栏布局的项目资产窗口）：
 * - 顶部工具栏：前进/后退/上级 + 面包屑导航 + 搜索 + 类型筛选 + 排序 + 网格/列表切换 + 刷新
 * - 左栏：文件夹树（点击导航右栏）
 * - 右栏：当前目录资产网格/列表（目录在前、文件在后），双击进入/选中
 * - 底部状态栏：选中项 + 总数量
 * 右键菜单（新建目录/复制/重命名/删除/复制路径/刷新）。资产操作统一走 assets store。
 */
import { computed, provide, onMounted, ref, watch } from "vue";
import { getAssetsStore } from "../stores/assets";
import { getProjectStore } from "../stores/project";
import { openContextMenu } from "../../lib/editor/context-menu";
import { setAssetSelection } from "../lib/active-panel";
import {
  listDirectoryChildren,
  type ChildEntry,
} from "../lib/asset-browser";
import {
  buildEntryMenu,
  buildContentMenu,
  buildBlankMenu,
  buildRefreshOnlyMenu,
  type AssetMenuApi,
} from "../lib/asset-menu";
import AssetTreeNode, {
  ASSET_DRAG_KEY,
  type AssetDragHandle,
  type AssetNode,
} from "./AssetTreeNode.vue";
import AssetEntryCell from "./AssetEntryCell.vue";
import AssetToolbar from "./AssetToolbar.vue";
import { useAssetTransfer } from "../composables/assets/useAssetTransfer";
import { useWorkshopMenu } from "../composables/assets/useWorkshopMenu";
import { useAssetActions } from "../composables/assets/useAssetActions";
import { useAssetItemActions } from "../composables/assets/useAssetItemActions";
import { isInternalAsset } from "../../lib/internal-assets";
import { isProtectedAsset } from "../lib/asset-guards";
import { materialTypeRegistry, shaderKindLabel } from "../../framework/material";
import "../../styles/components/assets-panel.scss";

const assetsStore = getAssetsStore();
const projectStore = getProjectStore();

// ---------------------------------------------------------------------------
// 树（左栏）：从平铺资产构建目录树
// ---------------------------------------------------------------------------
const root = computed<AssetNode[]>(() => {
  const tree: AssetNode[] = [];
  for (const a of assetsStore.assets) {
    const parts = a.path.split("/");
    let cursor = tree;
    let curPath = "";
    for (let i = 0; i < parts.length; i++) {
      curPath = curPath ? `${curPath}/${parts[i]}` : parts[i];
      const isLast = i === parts.length - 1;
      let node = cursor.find((c) => c.name === parts[i]);
      if (!node) {
        node = {
          name: parts[i],
          path: curPath,
          kind: isLast ? a.kind : "dir",
          size: isLast ? a.size : 0,
          children: [],
        };
        cursor.push(node);
      }
      if (!isLast) cursor = node.children;
    }
  }
  return tree;
});

// ---------------------------------------------------------------------------
// 导航状态：当前目录 + 历史
// ---------------------------------------------------------------------------
const currentDir = ref("assets");
const backStack = ref<string[]>([]);
const fwdStack = ref<string[]>([]);

function navigate(dir: string) {
  if (dir === currentDir.value) return;
  backStack.value.push(currentDir.value);
  fwdStack.value = [];
  currentDir.value = dir;
  selectedPaths.value = [];
  lastAnchor.value = null;
  setAssetSelection(null);
}
function goBack() {
  const p = backStack.value.pop();
  if (p !== undefined) {
    fwdStack.value.push(currentDir.value);
    currentDir.value = p;
  }
}
function goForward() {
  const p = fwdStack.value.pop();
  if (p !== undefined) {
    backStack.value.push(currentDir.value);
    currentDir.value = p;
  }
}
function goUp() {
  const i = currentDir.value.lastIndexOf("/");
  if (i > 0) navigate(currentDir.value.slice(0, i));
  else if (currentDir.value !== "") navigate("");
}

/** 切换项目时回到默认目录并重新加载资产 */
watch(
  () => projectStore.currentPath,
  (path) => {
    currentDir.value = "assets";
    backStack.value = [];
    fwdStack.value = [];
    if (path) void assetsStore.load(path);
  },
);

/** 面包屑 */
const crumbs = computed(() => {
  const parts = currentDir.value.split("/").filter(Boolean);
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") }));
});

// ---------------------------------------------------------------------------
// 筛选 / 排序
// ---------------------------------------------------------------------------
const query = ref("");
const typeFilter = ref("all");
const sortBy = ref("name");
const viewMode = ref<"grid" | "list">("grid");

/** 当前目录内容：目录在前、文件在后；搜索时递归展示 */
const children = computed<ChildEntry[]>(() =>
  listDirectoryChildren(assetsStore.assets, currentDir.value, query.value, typeFilter.value, sortBy.value),
);

/** 选中项（支持单选/多选，文件同时写入 store.selectedAsset 作为活跃资产） */
const selectedPaths = ref<string[]>([]);
const lastAnchor = ref<string | null>(null);
const selectedName = computed(() => {
  if (selectedPaths.value.length === 0) return null;
  if (selectedPaths.value.length === 1) {
    return children.value.find((c) => c.path === selectedPaths.value[0])?.name ?? null;
  }
  return `${selectedPaths.value.length} 项`;
});

// —— 资产操作（右键菜单）：动作下沉 composables/assets，面板只保留状态与接线 ——
const { workshopMenuCats, refreshWorkshopMenu } = useWorkshopMenu();
const itemActions = useAssetItemActions({ currentDir, selectedPaths, lastAnchor, children, navigate });
const assetActions = useAssetActions({ currentDir, isSrcDir, importAllowedDir });

function onItemClick(e: MouseEvent, item: ChildEntry) {
  const idx = selectedPaths.value.indexOf(item.path);
  if (e.ctrlKey || e.metaKey) {
    if (idx >= 0) selectedPaths.value.splice(idx, 1);
    else selectedPaths.value.push(item.path);
  } else if (e.shiftKey && lastAnchor.value) {
    const anchorIdx = children.value.findIndex((c) => c.path === lastAnchor.value);
    const itemIdx = children.value.findIndex((c) => c.path === item.path);
    if (anchorIdx >= 0 && itemIdx >= 0) {
      const a = Math.min(anchorIdx, itemIdx);
      const b = Math.max(anchorIdx, itemIdx);
      selectedPaths.value = children.value.slice(a, b + 1).map((c) => c.path);
    } else {
      selectedPaths.value = [item.path];
      lastAnchor.value = item.path;
    }
  } else {
    selectedPaths.value = [item.path];
    lastAnchor.value = item.path;
  }
  if (item.kind !== "dir") assetsStore.select(item.path);
  // 主选中项（文件或目录）供 F2 上下文重命名；多选时无单一主项
  setAssetSelection(selectedPaths.value.length === 1 ? selectedPaths.value[0] : null);
}

async function onItemContext(e: MouseEvent, item: ChildEntry) {
  e.preventDefault();
  e.stopPropagation();
  await refreshWorkshopMenu();
  openContextMenu(e, buildEntryMenu(item, menuApi));
}

function onContentClick(e: MouseEvent) {
  const t = e.target as HTMLElement | null;
  if (t?.closest(".am-item, input, select, button")) return;
  selectedPaths.value = [];
  lastAnchor.value = null;
  setAssetSelection(null);
}

/** 右栏空白区右键：在当前目录新建目录 + 刷新（内置 internal 目录只读，无新建） */
async function onContentContext(e: MouseEvent) {
  const t = e.target as HTMLElement | null;
  if (t?.closest(".am-item, input, select, button")) return;
  e.preventDefault();
  e.stopPropagation();
  await refreshWorkshopMenu();
  openContextMenu(e, buildContentMenu(currentDir.value, menuApi));
}

async function onBlankContext(e: MouseEvent) {
  const t = e.target as HTMLElement | null;
  if (t?.closest(".asset-row, input, select, button, textarea")) return;
  e.preventDefault();
  e.stopPropagation();
  await refreshWorkshopMenu();
  const items = isInternalAsset(currentDir.value)
    ? buildRefreshOnlyMenu(menuApi)
    : buildBlankMenu(menuApi);
  openContextMenu(e, items);
}

/** 面板 → asset-menu 的动作回调集合（结构/守卫在 asset-menu，动作在此闭包执行） */
const menuApi: AssetMenuApi = {
  isInternal: (p) => isInternalAsset(p),
  isProtected: (p) => isProtectedAsset(p),
  isSrcDir,
  importAllowed: importAllowedDir,
  shaderTypes: () =>
    materialTypeRegistry.list().map((d) => ({ key: d.key, label: shaderKindLabel(d.key) })),
  onOpenDir: (dir) => navigate(dir),
  onAddModelToScene: (item) => itemActions.addModelToScene(item),
  onAddAudioToScene: (item) => itemActions.addAudioToScene(item),
  onInstantiatePrefab: (item) => void itemActions.instantiatePrefab(item),
  onOpenScript: (item) => itemActions.openScriptAsset(item),
  onCopyInternal: (item) => void itemActions.copyInternalToProject(item),
  onCopy: (item) => void itemActions.doCopy(item),
  onRename: (item) => void itemActions.doRename(item),
  onDelete: (item) => void itemActions.doDelete(item),
  onNewScene: (dir) => void assetActions.doNewScene(dir),
  onNewScript: (dir) => void assetActions.doNewScript(dir),
  workshops: () => workshopMenuCats.value,
  onNewFromWorkshop: (dir, item) => void assetActions.doNewFromWorkshop(dir, item),
  onNewFolder: (dir) => void assetActions.doNewFolder(dir),
  onNewMaterial: (dir) => void assetActions.doNewMaterial(dir),
  onNewShader: (dir, kind) => void assetActions.doNewShader(dir, kind),
  onNewSkybox: (dir, kind) => void assetActions.doNewSkybox(dir, kind),
  onNewTextureCube: (dir) => void assetActions.doNewTextureCube(dir),
  onNewPrefab: (dir) => void assetActions.doNewPrefab(dir),
  onNewAnim: (dir) => void assetActions.doNewAnim(dir),
  onImport: (dir) => void assetActions.doImport(dir),
  onImportFolder: (dir) => void assetActions.doImportFolder(dir),
  onCopyPath: (p) => void itemActions.copyPath(p),
  onRefresh: () => void assetsStore.refresh(),
};

/** 是否允许把外部资产导入到该目录（src=脚本目录、internal=内置只读 不允许） */
function isSrcDir(dir: string): boolean {
  return dir === "src" || dir.startsWith("src/");
}
function importAllowedDir(dir: string): boolean {
  return !isSrcDir(dir) && !isInternalAsset(dir);
}

const {
  panelEl,
  dragOver,
  hoverPath,
  dragGhost,
  dragPaths,
  onItemMouseDown,
  onItemClickGuard,
  moveAssetsToDir,
} = useAssetTransfer({
  currentDir,
  selectedPaths,
  importAllowedDir,
  getProjectPath: () => projectStore.currentPath,
  moveTo: (root, rel, destDir) => assetsStore.moveTo(root, rel, destDir),
  importPaths: (root, destDir, paths) => assetsStore.importPaths(root, destDir, paths),
  onClickItem: (e, item) => onItemClick(e, item),
});

onMounted(() => {
  void refreshWorkshopMenu();
  if (projectStore.currentPath) void assetsStore.load(projectStore.currentPath);
});

provide<AssetDragHandle>(ASSET_DRAG_KEY, {
  getPaths: () => dragPaths.value,
  moveToDir: (paths, destDir) => {
    void moveAssetsToDir(paths, destDir);
  },
  hoverPath,
});
</script>

<template>
  <div
    ref="panelEl"
    class="asset-manager assets"
    @contextmenu.prevent
    @dragover.prevent
    @drop.prevent
  >
    <!-- 顶部工具栏：导航 + 面包屑 + 搜索 + 筛选 + 排序 + 视图 + 导入/刷新（AssetToolbar） -->
    <AssetToolbar
      :back-enabled="backStack.length > 0"
      :forward-enabled="fwdStack.length > 0"
      :up-enabled="currentDir !== ''"
      :crumbs="crumbs"
      :query="query"
      :type-filter="typeFilter"
      :sort-by="sortBy"
      :view-mode="viewMode"
      :can-import="!!projectStore.currentPath && importAllowedDir(currentDir)"
      @back="goBack"
      @forward="goForward"
      @up="goUp"
      @navigate="navigate"
      @update:query="query = $event"
      @update:type-filter="typeFilter = $event"
      @update:sort-by="sortBy = $event"
      @update:view-mode="viewMode = $event"
      @import="assetActions.doImport()"
      @import-folder="assetActions.doImportFolder()"
      @refresh="assetsStore.refresh"
    />

    <!-- 主体：左栏文件夹树 + 右栏资产内容 -->
    <div class="am-body">
      <div class="am-tree" @contextmenu.prevent="onBlankContext">
        <AssetTreeNode
          v-for="node in root"
          :key="node.path"
          :node="node"
          :depth="0"
          :active-path="currentDir"
          folders-only
          @select-dir="navigate"
        />
      </div>
      <div
        class="am-content"
        :class="'view-' + viewMode"
        @contextmenu="onContentContext"
        @click="onContentClick"
      >
        <div v-if="assetsStore.assets.length === 0" class="am-empty">未发现资产（项目需包含 assets/ 目录）</div>
        <div v-else-if="children.length === 0" class="am-empty">（空目录）</div>

        <!-- 网格/列表条目：展示与事件透传在 AssetEntryCell，数据与交互回调留在面板 -->
        <AssetEntryCell
          v-for="item in children"
          :key="item.path"
          :item="item"
          :view="viewMode"
          :selected="selectedPaths.includes(item.path)"
          :drop-over="item.kind === 'dir' && item.path === hoverPath"
          @click="onItemClickGuard($event, item)"
          @dblclick="itemActions.onItemDblClick(item)"
          @context="onItemContext($event, item)"
          @mousedown="onItemMouseDown($event, item)"
        />
      </div>
    </div>

    <!-- 状态栏 -->
    <div class="am-status">
      <span v-if="selectedName" class="am-status-sel">选中: {{ selectedName }}</span>
      <span class="am-status-count">{{ children.length }} 项</span>
    </div>

    <!-- 外部文件拖入指示：松开即导入到当前目录 -->
    <div v-if="dragOver && importAllowedDir(currentDir)" class="am-import-overlay">
      <div class="am-import-overlay-box">松开鼠标 · 导入资产到 {{ currentDir || "项目根" }}</div>
    </div>

    <!-- 拖拽浮动指示（跟随鼠标） -->
    <teleport to="body">
      <div
        v-if="dragGhost"
        class="asset-drag-ghost"
        :style="{ left: dragGhost.x + 'px', top: dragGhost.y + 'px' }"
      >
        <span>{{ dragGhost.label }}</span>
      </div>
    </teleport>
  </div>
</template>
