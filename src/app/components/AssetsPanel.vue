<script setup lang="ts">
/**
 * 资产面板（Unity Project 窗口风格，双栏布局）：
 * - 顶部工具栏：前进/后退/上级 + 面包屑导航 + 搜索 + 类型筛选 + 排序 + 网格/列表切换 + 刷新
 * - 左栏：文件夹树（点击导航右栏）
 * - 右栏：当前目录资产网格/列表（目录在前、文件在后），双击进入/选中
 * - 底部状态栏：选中项 + 总数量
 * 右键菜单（新建目录/复制/重命名/删除/复制路径/刷新）。资产操作统一走 assets store。
 */
import { computed, provide, onMounted, ref, watch } from "vue";
import { getAssetsStore } from "../stores/assets";
import { getProjectStore } from "../stores/project";
import { assetService } from "../services/assetService";
import { logStore } from "../stores/log";
import { openContextMenu } from "../../lib/editor/context-menu";
import { prompt } from "../lib/prompt";
import { confirm } from "../lib/confirm";
import { instantiatePrefabAsset } from "../lib/prefabs";
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
import { useAssetTransfer } from "./useAssetTransfer";
import { api } from "../../lib/api";
import { isInternalAsset } from "../../lib/internal-assets";
import { isProtectedAsset } from "../lib/asset-guards";
import { materialTypeRegistry, shaderKindLabel } from "../../framework/material";
import { isModelAssetRel } from "../../framework/mesh";
import { isAudioAssetRel } from "../../framework/audio";
import { getEditorStore } from "../stores/editor";
import { getScriptsStore } from "../stores/scripts";
import { dispatchCommand } from "../commands";
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
  lastAnchor = null;
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
let lastAnchor: string | null = null;
const selectedName = computed(() => {
  if (selectedPaths.value.length === 0) return null;
  if (selectedPaths.value.length === 1) {
    return children.value.find((c) => c.path === selectedPaths.value[0])?.name ?? null;
  }
  return `${selectedPaths.value.length} 项`;
});

// ---------------------------------------------------------------------------
// 资产操作（右键菜单）
// ---------------------------------------------------------------------------
/** 把内置资源（internal/…）复制到项目资产目录（业务与命名下沉 assetService） */
async function copyInternalToProject(item: ChildEntry): Promise<void> {
  const root = projectStore.currentPath;
  if (!root || item.kind === "dir") return;
  const rel = await assetService.copyInternalToProject(
    root,
    item.name,
    item.path,
    assetsStore.assets,
  );
  if (rel) await assetsStore.load(root);
}

function onItemClick(e: MouseEvent, item: ChildEntry) {
  const idx = selectedPaths.value.indexOf(item.path);
  if (e.ctrlKey || e.metaKey) {
    if (idx >= 0) selectedPaths.value.splice(idx, 1);
    else selectedPaths.value.push(item.path);
  } else if (e.shiftKey && lastAnchor) {
    const anchorIdx = children.value.findIndex((c) => c.path === lastAnchor);
    const itemIdx = children.value.findIndex((c) => c.path === item.path);
    if (anchorIdx >= 0 && itemIdx >= 0) {
      const a = Math.min(anchorIdx, itemIdx);
      const b = Math.max(anchorIdx, itemIdx);
      selectedPaths.value = children.value.slice(a, b + 1).map((c) => c.path);
    } else {
      selectedPaths.value = [item.path];
      lastAnchor = item.path;
    }
  } else {
    selectedPaths.value = [item.path];
    lastAnchor = item.path;
  }
  if (item.kind !== "dir") assetsStore.select(item.path);
  // 主选中项（文件或目录）供 F2 上下文重命名；多选时无单一主项
  setAssetSelection(selectedPaths.value.length === 1 ? selectedPaths.value[0] : null);
}

function onItemDblClick(item: ChildEntry) {
  selectedPaths.value = [item.path];
  lastAnchor = item.path;
  if (item.kind === "dir") {
    navigate(item.path);
    return;
  }
  // 双击 .scene 资产：切换当前打开场景（重载引擎场景，层级/视口随之更新）
  if (item.kind === "scene") {
    if (isInternalAsset(item.path)) {
      logStore.log("warn", "内置目录不存在可打开的工程场景");
      return;
    }
    void projectStore.openScene(item.path).then((ok) => {
      if (!ok) logStore.log("error", `打开场景失败: ${item.path}`, "engine");
    });
    return;
  }
  // 双击模型资产：作为模型网格加入当前场景
  if (isModelAssetRel(item.path)) {
    addModelToScene(item);
    return;
  }
  // 双击音频资产：作为音源节点加入当前场景（绑定该资产）
  if (isAudioAssetRel(item.path)) {
    addAudioToScene(item);
    return;
  }
  // 双击 .ts 脚本：切到脚本工作台打开编辑
  if (item.kind === "ts") {
    openScriptAsset(item);
    return;
  }
  // 其余资产：双击仅选中并记录日志
  assetsStore.select(item.path);
  logStore.log("info", `${item.name} (${item.kind})`);
}

/** 打开脚本到脚本工作台（双击 / 右键菜单共用） */
function openScriptAsset(item: ChildEntry): void {
  getEditorStore().setViewMode("script");
  void getScriptsStore().openScript(item.path);
}

/** 把模型资产作为网格节点加入当前场景（source=model；动画自动绑定） */
function addModelToScene(item: ChildEntry): void {
  const store = getEditorStore();
  if (!store.state.mounted) {
    logStore.log("warn", "编辑器未就绪，无法添加模型");
    return;
  }
  void dispatchCommand("node.add", { kind: "model", path: item.path }).then((r) => {
    if (r.ok && r.value && typeof r.value === "object" && "name" in r.value) {
      logStore.log("success", `已添加模型节点 ${(r.value as { name: string }).name}`, "engine");
    }
  });
}

/** 把音频资产作为音源节点加入当前场景（audioNode 并绑定该资产） */
function addAudioToScene(item: ChildEntry): void {
  const store = getEditorStore();
  if (!store.state.mounted) {
    logStore.log("warn", "编辑器未就绪，无法添加音源");
    return;
  }
  void dispatchCommand("node.add", { kind: "audio", path: item.path }).then((r) => {
    if (r.ok && r.value && typeof r.value === "object" && "name" in r.value) {
      logStore.log("success", `已添加音源节点 ${(r.value as { name: string }).name}`, "engine");
    }
  });
}

function onItemContext(e: MouseEvent, item: ChildEntry) {
  e.preventDefault();
  e.stopPropagation();
  openContextMenu(e, buildEntryMenu(item, menuApi));
}

function onContentClick(e: MouseEvent) {
  const t = e.target as HTMLElement | null;
  if (t?.closest(".am-item, input, select, button")) return;
  selectedPaths.value = [];
  lastAnchor = null;
  setAssetSelection(null);
}

/** 右栏空白区右键：在当前目录新建目录 + 刷新（内置 internal 目录只读，无新建） */
function onContentContext(e: MouseEvent) {
  const t = e.target as HTMLElement | null;
  if (t?.closest(".am-item, input, select, button")) return;
  e.preventDefault();
  e.stopPropagation();
  openContextMenu(e, buildContentMenu(currentDir.value, menuApi));
}

function onBlankContext(e: MouseEvent) {
  const t = e.target as HTMLElement | null;
  if (t?.closest(".asset-row, input, select, button, textarea")) return;
  e.preventDefault();
  e.stopPropagation();
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
  onAddModelToScene: (item) => addModelToScene(item),
  onAddAudioToScene: (item) => addAudioToScene(item),
  onInstantiatePrefab: (item) => void instantiatePrefab(item),
  onOpenScript: (item) => openScriptAsset(item),
  onCopyInternal: (item) => void copyInternalToProject(item),
  onCopy: (item) => void doCopy(item),
  onRename: (item) => void doRename(item),
  onDelete: (item) => void doDelete(item),
  onNewScene: (dir) => void doNewScene(dir),
  onNewScript: (dir) => void doNewScript(dir),
  onNewFolder: (dir) => void doNewFolder(dir),
  onNewMaterial: (dir) => void doNewMaterial(dir),
  onNewShader: (dir, kind) => void doNewShader(dir, kind),
  onNewSkybox: (dir, kind) => void doNewSkybox(dir, kind),
  onNewTextureCube: (dir) => void doNewTextureCube(dir),
  onNewPrefab: (dir) => void doNewPrefab(dir),
  onNewAnim: (dir) => void doNewAnim(dir),
  onImport: (dir) => void doImport(dir),
  onImportFolder: (dir) => void doImportFolder(dir),
  onCopyPath: (p) => void copyPath(p),
  onRefresh: () => void assetsStore.refresh(),
};

async function doNewFolder(dir: string) {
  const root = projectStore.currentPath;
  if (!root) return;
  const name = await prompt({
    title: "新建目录",
    label: dir,
    initial: "NewFolder",
    confirmText: "创建",
  });
  if (!name) return;
  const rel = `${dir}/${name}`;
  await assetsStore.createFolder(root, rel);
}

/** 新建 3D 场景资产（到 dir；src/内置目录不允许） */
async function doNewScene(dir: string) {
  const root = projectStore.currentPath;
  if (!root) return;
  if (!importAllowedDir(dir)) {
    logStore.log("warn", isSrcDir(dir)
      ? "src 目录不允许新建场景"
      : "内置目录只读，不允许新建场景");
    return;
  }
  const name = await prompt({
    title: "新建场景",
    label: dir || "项目根",
    initial: "NewScene",
    confirmText: "创建",
  });
  if (!name) return;
  await assetsStore.createSceneAsset(root, dir, name);
}

/** 新建 TS 脚本（src/ 目录专用；模板创建后切到脚本工作台打开） */
async function doNewScript(dir: string) {
  if (!isSrcDir(dir)) {
    logStore.log("warn", "脚本只能创建在 src 目录内");
    return;
  }
  const name = await prompt({
    title: "新建脚本",
    label: `${dir}/（脚本名）`,
    placeholder: "MyScript",
    confirmText: "创建",
  });
  if (!name?.trim()) return;
  await getScriptsStore().createScript(name.trim());
}

/** 新建空白预制体（assets/prefabs 语义上的目录均可；模板创建） */
async function doNewPrefab(dir: string): Promise<void> {
  const root = projectStore.currentPath;
  if (!root) return;
  if (!importAllowedDir(dir) || isSrcDir(dir)) {
    logStore.log("warn", isSrcDir(dir) ? "src 目录不允许新建预制体" : "内置目录只读，不允许新建预制体");
    return;
  }
  const name = await prompt({
    title: "新建预制体",
    label: dir || "项目根",
    initial: "NewPrefab",
    confirmText: "创建",
  });
  if (!name?.trim()) return;
  await assetsStore.createPrefabAsset(root, dir, name.trim());
}

/** 新建关键帧动画剪辑（.anim；模板创建） */
async function doNewAnim(dir: string): Promise<void> {
  const root = projectStore.currentPath;
  if (!root) return;
  if (!importAllowedDir(dir) || isSrcDir(dir)) {
    logStore.log("warn", isSrcDir(dir) ? "src 目录不允许新建动画" : "内置目录只读，不允许新建动画");
    return;
  }
  const name = await prompt({
    title: "新建动画",
    label: dir || "项目根",
    initial: "NewAnimation",
    confirmText: "创建",
  });
  if (!name?.trim()) return;
  await assetsStore.createAnimAsset(root, dir, name.trim());
}
/** 实例化预制体资产到当前场景（挂到选中节点/根下；一次撤销） */
async function instantiatePrefab(item: { path: string }): Promise<void> {
  await instantiatePrefabAsset(item.path);
}

/** 新建材质资产（到 dir；材质与着色器分离，默认挂内置 PBR 着色器；按名去重，无需弹窗） */
async function doNewMaterial(dir: string): Promise<void> {
  const root = projectStore.currentPath;
  if (!root) return;
  if (!importAllowedDir(dir)) {
    logStore.log("warn", isSrcDir(dir)
      ? "src 目录不允许新建材质"
      : "内置目录只读，不允许新建材质");
    return;
  }
  await assetsStore.createMaterialAsset(root, dir);
}

/** 新建着色器资产（.shader；PBR/Unlit/卡通三种渲染程序；按种类基名去重，无需弹窗） */
async function doNewShader(dir: string, kind: string): Promise<void> {
  const root = projectStore.currentPath;
  if (!root) return;
  if (!importAllowedDir(dir)) {
    logStore.log("warn", isSrcDir(dir)
      ? "src 目录不允许新建着色器"
      : "内置目录只读，不允许新建着色器");
    return;
  }
  await assetsStore.createShaderAsset(root, dir, kind);
}

/** 新建天空盒材质资产（.mat；程序化/立方体两种；按类型基名去重，无需弹窗） */
async function doNewSkybox(dir: string, kind: "procedural" | "cube"): Promise<void> {
  const root = projectStore.currentPath;
  if (!root) return;
  if (!importAllowedDir(dir)) {
    logStore.log("warn", isSrcDir(dir)
      ? "src 目录不允许新建天空盒"
      : "内置目录只读，不允许新建天空盒");
    return;
  }
  await assetsStore.createSkyboxAsset(root, dir, kind);
}

/** 新建 TextureCube 资产（立方体纹理；默认引用内置全景图，创建即可用；按名去重无需弹窗） */
async function doNewTextureCube(dir: string): Promise<void> {
  const root = projectStore.currentPath;
  if (!root) return;
  if (!importAllowedDir(dir)) {
    logStore.log("warn", isSrcDir(dir)
      ? "src 目录不允许新建 TextureCube"
      : "内置目录只读，不允许新建 TextureCube");
    return;
  }
  await assetsStore.createTextureCubeAsset(root, dir);
}

async function doCopy(item: ChildEntry) {
  const root = projectStore.currentPath;
  if (!root) return;
  await assetsStore.duplicate(root, item.path);
}

async function doRename(item: ChildEntry) {
  // 重命名语义（补扩展名/脚本引用随动）统一在 asset.renameSelected 命令（资产面板右键 / F2 共用）
  await dispatchCommand("asset.renameSelected", { rel: item.path });
}

async function doDelete(item: ChildEntry) {
  const root = projectStore.currentPath;
  if (!root) return;
  const multi = selectedPaths.value.length > 1 && selectedPaths.value.includes(item.path);
  const targets = multi ? [...selectedPaths.value] : [item.path];
  const hasDir = targets.some((p) => {
    const c = children.value.find((x) => x.path === p);
    return c?.kind === "dir";
  });
  const ok = await confirm({
    title: multi ? "删除多个资产" : "删除资产",
    message: hasDir
      ? `确定删除${multi ? `这 ${targets.length} 项` : "该资产"}及其目录内容吗？此操作不可恢复。`
      : `确定删除${multi ? `这 ${targets.length} 项` : "该资产"}吗？此操作不可恢复。`,
    confirmText: multi ? `删除 ${targets.length} 项` : "删除",
    danger: true,
  });
  if (!ok) return;
  for (const p of targets) {
    // 脚本删除走 scripts store：同步移除场景内组件引用与编辑器标签页
    if (p.endsWith(".ts") && p.startsWith("src/")) {
      await getScriptsStore().deleteScript(p);
      continue;
    }
    await assetsStore.remove(root, p);
  }
  if (multi) {
    selectedPaths.value = [];
    lastAnchor = null;
    if (
      currentDir.value === "assets" ||
      currentDir.value === "" ||
      targets.some((t) => currentDir.value === t || currentDir.value.startsWith(t + "/"))
    ) {
      navigate("assets");
    }
  }
}

async function copyPath(path: string) {
  try {
    await navigator.clipboard.writeText(path);
    logStore.log("success", `已复制路径: ${path}`);
  } catch {
    logStore.log("warn", `复制失败: ${path}（剪贴板不可用）`);
  }
}

/** 是否允许把外部资产导入到该目录（src=脚本目录、internal=内置只读 不允许） */
function isSrcDir(dir: string): boolean {
  return dir === "src" || dir.startsWith("src/");
}
function importAllowedDir(dir: string): boolean {
  return !isSrcDir(dir) && !isInternalAsset(dir);
}

/** 导入按钮：打开多文件选择对话框，导入到目标目录 */
async function doImport(dir: string = currentDir.value): Promise<void> {
  const root = projectStore.currentPath;
  if (!root) return;
  if (!importAllowedDir(dir)) {
    logStore.log("warn", isSrcDir(dir)
      ? "src 目录不允许导入资产（脚本目录，用「新建脚本」创建）"
      : "内置目录只读，不允许导入资产");
    return;
  }
  const picked = await api.pickImportFiles(`导入资产到 ${dir || "项目根"}`);
  if (!picked || picked.length === 0) return;
  await assetsStore.importPaths(root, dir, picked);
}

/** 导入目录按钮：多选文件夹后整体复制到目标目录 */
async function doImportFolder(dir: string = currentDir.value): Promise<void> {
  const root = projectStore.currentPath;
  if (!root) return;
  if (!importAllowedDir(dir)) {
    logStore.log("warn", isSrcDir(dir)
      ? "src 目录不允许导入文件夹（脚本目录，用「新建脚本」创建）"
      : "内置目录只读，不允许导入文件夹");
    return;
  }
  const picked = await api.pickImportFolders(`导入文件夹到 ${dir || "项目根"}`);
  if (!picked || picked.length === 0) return;
  await assetsStore.importPaths(root, dir, picked);
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
      @import="doImport()"
      @import-folder="doImportFolder()"
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
          @dblclick="onItemDblClick(item)"
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
