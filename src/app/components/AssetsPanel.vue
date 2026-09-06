<script setup lang="ts">
/**
 * 资产面板（Unity Project 窗口风格，双栏布局）：
 * - 顶部工具栏：前进/后退/上级 + 面包屑导航 + 搜索 + 类型筛选 + 排序 + 网格/列表切换 + 刷新
 * - 左栏：文件夹树（点击导航右栏）
 * - 右栏：当前目录资产网格/列表（目录在前、文件在后），双击进入/选中
 * - 底部状态栏：选中项 + 总数量
 * 右键菜单（新建目录/复制/重命名/删除/复制路径/刷新）。资产操作统一走 assets store。
 */
import { computed, provide, onMounted, onUnmounted, ref, watch } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getAssetsStore } from "../stores/assets";
import { getProjectStore } from "../stores/project";
import { logStore } from "../stores/log";
import { openContextMenu, menuSeparator, type CtxMenuItem } from "../../lib/editor/context-menu";
import { prompt } from "../lib/prompt";
import { confirm } from "../lib/confirm";
import {
  listDirectoryChildren,
  ASSET_TYPE_FILTERS as TYPE_FILTERS,
  type ChildEntry,
} from "../lib/asset-browser";
import AssetTreeNode, {
  ASSET_DRAG_KEY,
  type AssetDragHandle,
  type AssetNode,
} from "./AssetTreeNode.vue";
import AssetTypeIcon from "./AssetTypeIcon.vue";
import { fmtSize } from "../lib/format";
import { api } from "../../lib/api";
import { isInternalAsset } from "../../lib/internal-assets";
import { isProtectedAsset } from "../lib/asset-guards";
import { sanitizeAssetStem } from "../lib/materials";
import { materialTypeRegistry } from "../../framework/material";
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
function parentOf(path: string): string | null {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : i === 0 ? "" : null;
}

/** 内置资源按类型复制到项目的默认目录 */
const INTERNAL_COPY_DIRS: Record<string, string> = {
  mat: "assets/materials",
  ts: "src",
  png: "assets/textures",
  jpg: "assets/textures",
  jpeg: "assets/textures",
  webp: "assets/textures",
  bmp: "assets/textures",
  glb: "assets/models",
  gltf: "assets/models",
  obj: "assets/models",
  json: "assets",
};

/** 目录是否可作为拖放目标（内置 internal 目录只读，不可作为落点） */
function dropDirAttr(item: ChildEntry): string | undefined {
  return item.kind === "dir" && !isInternalAsset(item.path) ? item.path : undefined;
}

/** 把内置资源（internal/…）复制到项目资产目录（只读源 → 项目内可编辑副本） */
async function copyInternalToProject(item: ChildEntry): Promise<void> {
  const root = projectStore.currentPath;
  if (!root || item.kind === "dir") return;
  const dot = item.name.lastIndexOf(".");
  const ext = dot >= 0 ? item.name.slice(dot + 1).toLowerCase() : "";
  const stem = sanitizeAssetStem(dot >= 0 ? item.name.slice(0, dot) : item.name);
  const dir = INTERNAL_COPY_DIRS[ext] ?? "assets";
  const used = new Set(
    assetsStore.assets.filter((a) => a.kind !== "dir").map((a) => a.path.toLowerCase()),
  );
  let name = stem;
  let n = 2;
  const candidate = (base: string) => (ext ? `${base}.${ext}` : base);
  let fname = candidate(name);
  while (used.has(`${dir}/${fname}`.toLowerCase())) {
    name = `${stem} ${n++}`;
    fname = candidate(name);
  }
  const rel = `${dir}/${fname}`;
  // 二进制资源（图片/模型等）走 base64；文本资源（材质/脚本等）走文本
  const BINARY_EXTS = new Set([
    "png", "jpg", "jpeg", "webp", "gif", "bmp",
    "glb", "gltf", "obj", "bin",
  ]);
  try {
    if (BINARY_EXTS.has(ext)) {
      const b64 = await api.readInternalBinary(item.path);
      if (b64 == null) throw new Error("读取内置资源失败");
      await api.writeAssetBinary(root, rel, b64);
    } else {
      const content = await api.readInternalAsset(item.path);
      if (content == null) throw new Error("读取内置资源失败");
      await api.writeText(root, rel, content);
    }
    await assetsStore.load(root);
    logStore.log("success", `已复制到项目: ${rel}`);
  } catch (e) {
    logStore.log("error", `复制内置资源到项目失败: ${e}`);
  }
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
  // 本项目无 openScene/openTextEditor：双击非目录仅选中并记录日志
  assetsStore.select(item.path);
  logStore.log("info", `${item.name} (${item.kind})`);
}

function onItemContext(e: MouseEvent, item: ChildEntry) {
  e.preventDefault();
  e.stopPropagation();
  const items: CtxMenuItem[] = [];
  const isProtected = isProtectedAsset(item.path);
  const isInternal = isInternalAsset(item.path);

  if (item.kind === "dir") items.push({ label: "打开", onClick: () => navigate(item.path) });

  if (isProtected) {
    // 内置资源 internal/… 与项目固定根目录 assets、src：只读，不可复制/重命名/删除
    if (!isInternal && item.kind === "dir" && item.path === "assets") {
      // assets 固定根目录内仍可新建场景/材质/子目录（assets/materials 等）；src 为脚本目录不提供
      const sc = sceneCreateItem(item.path);
      if (sc) items.push(sc);
      const mc = materialCreateItem(item.path);
      if (mc) items.push(mc);
      items.push({ label: "新建目录", onClick: () => void doNewFolder(item.path) });
      items.push(menuSeparator(), ...importMenuItems(item.path));
    } else if (isInternal && item.kind !== "dir") {
      // 内置文件可「复制到项目」生成项目内可编辑副本
      items.push({ label: "复制到项目", onClick: () => void copyInternalToProject(item) });
    }
  } else {
    items.push(
      { label: "复制", onClick: () => void doCopy(item) },
      { label: "重命名", onClick: () => void doRename(item) },
      { label: "删除", danger: true, onClick: () => void doDelete(item) },
    );
    const targetDir = item.kind === "dir" ? item.path : parentOf(item.path);
    if (targetDir != null) {
      const sc = sceneCreateItem(targetDir);
      if (sc) items.push(sc);
      const mc = materialCreateItem(targetDir);
      if (mc) items.push(mc);
      items.push({ label: "新建目录", onClick: () => void doNewFolder(targetDir) });
      items.push(menuSeparator(), ...importMenuItems(targetDir));
    }
  }
  items.push(menuSeparator());
  items.push({ label: "复制路径", onClick: () => void copyPath(item.path) });
  openContextMenu(e, items);
}

/** 右栏空白区点击：清空选中 */
function onContentClick(e: MouseEvent) {
  const t = e.target as HTMLElement | null;
  if (t?.closest(".am-item, input, select, button")) return;
  selectedPaths.value = [];
  lastAnchor = null;
}

/** 右栏空白区右键：在当前目录新建目录 + 刷新（内置 internal 目录只读，无新建） */
function onContentContext(e: MouseEvent) {
  const t = e.target as HTMLElement | null;
  if (t?.closest(".am-item, input, select, button")) return;
  e.preventDefault();
  e.stopPropagation();
  const items: CtxMenuItem[] = [];
  if (!isInternalAsset(currentDir.value)) {
    const sc = sceneCreateItem(currentDir.value);
    if (sc) items.push(sc);
    const mc = materialCreateItem(currentDir.value);
    if (mc) items.push(mc);
    items.push({ label: "新建目录", onClick: () => void doNewFolder(currentDir.value) });
    items.push(menuSeparator(), ...importMenuItems(currentDir.value));
  }
  items.push(menuSeparator(), { label: "刷新资产", onClick: () => void assetsStore.refresh() });
  openContextMenu(e, items);
}

/** 左栏（树）空白区右键：默认位置新建场景/目录 + 导入 + 刷新 */
function onBlankContext(e: MouseEvent) {
  const t = e.target as HTMLElement | null;
  if (t?.closest(".asset-row, input, select, button, textarea")) return;
  e.preventDefault();
  e.stopPropagation();
  const items: CtxMenuItem[] = [];
  if (!isInternalAsset(currentDir.value)) {
    const sc = sceneCreateItem("assets");
    if (sc) items.push(sc);
    const mc = materialCreateItem("assets");
    if (mc) items.push(mc);
    items.push({ label: "新建目录", onClick: () => void doNewFolder("assets") });
    items.push(menuSeparator(), ...importMenuItems("assets"));
  }
  items.push(menuSeparator(), { label: "刷新资产", onClick: () => void assetsStore.refresh() });
  openContextMenu(e, items);
}

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

/** 目录允许时的“新建场景”菜单项（null 表示不提供） */
function sceneCreateItem(dir: string): CtxMenuItem | null {
  if (!importAllowedDir(dir)) return null;
  return { label: "新建场景", onClick: () => void doNewScene(dir) };
}

/** 新建材质资产（到 dir；类型由工厂注册表提供默认参数；命名按类型名去重，无需弹窗） */
async function doNewMaterial(dir: string, typeKey: string): Promise<void> {
  const root = projectStore.currentPath;
  if (!root) return;
  if (!importAllowedDir(dir)) {
    logStore.log("warn", isSrcDir(dir)
      ? "src 目录不允许新建材质"
      : "内置目录只读，不允许新建材质");
    return;
  }
  await assetsStore.createMaterialAsset(root, dir, typeKey);
}

/** 目录允许时的“新建材质”子菜单（二级列出已注册材质类型；null 表示不提供） */
function materialCreateItem(dir: string): CtxMenuItem | null {
  if (!importAllowedDir(dir)) return null;
  return {
    label: "新建材质",
    children: materialTypeRegistry.list().map((def) => ({
      label: def.label,
      onClick: () => void doNewMaterial(dir, def.key),
    })),
  };
}

async function doCopy(item: ChildEntry) {
  const root = projectStore.currentPath;
  if (!root) return;
  await assetsStore.duplicate(root, item.path);
}

async function doRename(item: ChildEntry) {
  const root = projectStore.currentPath;
  if (!root) return;
  const newName = await prompt({
    title: "重命名",
    label: item.name,
    initial: item.name,
    confirmText: "重命名",
  });
  if (!newName || newName === item.name) return;
  // 文件重命名：新名未带后缀时自动补原扩展名（目录不补；隐藏文件 .env 等也不补）
  let finalName = newName;
  if (item.kind !== "dir") {
    const slash = item.path.lastIndexOf("/");
    const dot = item.path.lastIndexOf(".");
    if (dot > slash && dot > 0 && !finalName.includes(".")) {
      finalName = finalName + item.path.slice(dot);
    }
  }
  await assetsStore.rename(root, item.path, finalName);
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
  for (const p of targets) await assetsStore.remove(root, p);
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

// ---------------------------------------------------------------------------
// 资产面板内部拖拽（把文件/文件夹拖到另一个目录移动）
// 注意：Tauri 2 dragDropEnabled 默认拦截 WebView 内的 HTML5 draggable 拖放事件，
// 因此这里改用鼠标事件（mousedown/mousemove/mouseup）自建内部拖拽。
// ---------------------------------------------------------------------------
const dragPaths = ref<string[] | null>(null);
interface DragStart {
  x: number;
  y: number;
  paths: string[];
}
let dragStart: DragStart | null = null;
let dragActive = false;
let suppressClickUntil = 0;

const hoverPath = ref<string | null>(null);
const dragGhost = ref<{ x: number; y: number; label: string } | null>(null);

function onItemMouseDown(e: MouseEvent, item: ChildEntry) {
  if (e.button !== 0) return;
  if (isProtectedAsset(item.path)) return; // 内置资源与项目固定目录（assets/src）只读，不能拖拽移动
  const draggingAll = selectedPaths.value.includes(item.path);
  dragStart = {
    x: e.clientX,
    y: e.clientY,
    paths: draggingAll && selectedPaths.value.length > 0 ? [...selectedPaths.value] : [item.path],
  };
  dragActive = false;
  window.addEventListener("mousemove", onWindowMouseMove);
  window.addEventListener("mouseup", onWindowMouseUp);
}

function findDropTarget(x: number, y: number, paths: string[] | null): string | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el || el.classList.contains("asset-drag-ghost")) return null;
  const dirEl = el.closest<HTMLElement>("[data-drop-dir]");
  if (dirEl) {
    const p = dirEl.getAttribute("data-drop-dir");
    if (p) {
      if (paths && paths.includes(p)) return null;
      return p;
    }
  }
  if (el.closest(".am-content")) return currentDir.value;
  return null;
}

function onWindowMouseMove(e: MouseEvent) {
  if (!dragStart) return;
  if (!dragActive) {
    if (Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y) < 4) return;
    dragActive = true;
    dragPaths.value = dragStart.paths;
  }
  dragGhost.value = { x: e.clientX, y: e.clientY, label: dragStart.paths[0] };
  hoverPath.value = findDropTarget(e.clientX, e.clientY, dragStart.paths);
}

function onWindowMouseUp(e: MouseEvent) {
  window.removeEventListener("mousemove", onWindowMouseMove);
  window.removeEventListener("mouseup", onWindowMouseUp);
  const s = dragStart;
  dragStart = null;
  const wasActive = dragActive;
  dragActive = false;
  if (!wasActive) return;
  suppressClickUntil = Date.now() + 150;
  dragPaths.value = null;
  dragGhost.value = null;
  hoverPath.value = null;
  if (s) {
    const target = findDropTarget(e.clientX, e.clientY, s.paths);
    if (target && !s.paths.includes(target)) void moveAssetsToDir(s.paths, target);
  }
}

function onItemClickGuard(e: MouseEvent, item: ChildEntry) {
  if (Date.now() < suppressClickUntil) return;
  onItemClick(e, item);
}

async function moveAssetsToDir(paths: string[], destDir: string) {
  const root = projectStore.currentPath;
  if (!root) return;
  dragPaths.value = null;
  for (const p of paths) await assetsStore.moveTo(root, p, destDir);
}

// ---------------------------------------------------------------------------
// 资产导入（参考 LQEN）：按钮（文件/目录多选）+ 窗口级拖放导入
// ---------------------------------------------------------------------------
const panelEl = ref<HTMLElement | null>(null);
const dragOver = ref(false);

/** 是否允许把外部资产导入到该目录（src=脚本目录、internal=内置只读 不允许） */
function isSrcDir(dir: string): boolean {
  return dir === "src" || dir.startsWith("src/");
}
function importAllowedDir(dir: string): boolean {
  return !isSrcDir(dir) && !isInternalAsset(dir);
}

/** 导入菜单项（空白区/目录右键；dir 为导入目标目录） */
function importMenuItems(dir: string): CtxMenuItem[] {
  if (!importAllowedDir(dir)) return [];
  return [
    { label: "导入资产…", onClick: () => void doImport(dir) },
    { label: "导入目录…", onClick: () => void doImportFolder(dir) },
  ];
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

/** 外部文件拖放导入：Tauri 窗口级 onDragDropEvent（拖入系统文件到面板内） */
let unlistenDrop: (() => void) | null = null;

async function setupExternalDrop(): Promise<void> {
  try {
    const win = getCurrentWindow();
    unlistenDrop = await win.onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "enter" || p.type === "over") {
        if (panelEl.value) {
          const r = panelEl.value.getBoundingClientRect();
          const sf = window.devicePixelRatio || 1;
          const x = p.position.x / sf;
          const y = p.position.y / sf;
          dragOver.value = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        }
      } else if (p.type === "drop") {
        const inside = dragOver.value;
        dragOver.value = false;
        if (!inside || !p.paths || p.paths.length === 0) return;
        const root = projectStore.currentPath;
        const dir = currentDir.value;
        if (!root) return;
        if (!importAllowedDir(dir)) {
          logStore.log("warn", "该目录不允许拖放导入（src/内置只读）");
          return;
        }
        void assetsStore.importPaths(root, dir, p.paths);
      } else {
        // leave / cancel
        dragOver.value = false;
      }
    });
  } catch (e) {
    logStore.log("warn", `外部拖放监听不可用: ${e}`);
  }
}

onMounted(() => {
  void setupExternalDrop();
  if (projectStore.currentPath) void assetsStore.load(projectStore.currentPath);
});

onUnmounted(() => {
  unlistenDrop?.();
  unlistenDrop = null;
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
    <!-- 顶部工具栏：导航 + 面包屑 + 搜索 + 筛选 + 排序 + 视图 + 刷新 -->
    <div class="am-toolbar">
      <button class="am-btn" :disabled="backStack.length === 0" title="后退" @click="goBack">◀</button>
      <button class="am-btn" :disabled="fwdStack.length === 0" title="前进" @click="goForward">▶</button>
      <button class="am-btn" :disabled="currentDir === ''" title="上级目录" @click="goUp">▲</button>
      <div class="am-crumbs" title="当前目录">
        <button v-if="crumbs.length === 0" class="crumb" @click="navigate('')">根</button>
        <template v-for="(c, i) in crumbs" :key="c.path">
          <span v-if="i > 0" class="crumb-sep">▸</span>
          <button class="crumb" :class="{ cur: i === crumbs.length - 1 }" @click="navigate(c.path)">
            {{ c.name }}
          </button>
        </template>
      </div>
      <span class="spacer"></span>
      <input v-model="query" class="am-search" type="text" placeholder="搜索资产…" title="按名称搜索（递归当前目录）" />
      <select v-model="typeFilter" class="am-select" title="按类型筛选">
        <option v-for="f in TYPE_FILTERS" :key="f.id" :value="f.id">{{ f.label }}</option>
      </select>
      <select v-model="sortBy" class="am-select" title="排序">
        <option value="name">按名称</option>
        <option value="type">按类型</option>
        <option value="size">按大小</option>
      </select>
      <div class="am-view-toggle" title="视图模式">
        <button class="am-btn" :class="{ on: viewMode === 'grid' }" title="网格视图" @click="viewMode = 'grid'">▦</button>
        <button class="am-btn" :class="{ on: viewMode === 'list' }" title="列表视图" @click="viewMode = 'list'">☰</button>
      </div>
      <button
        class="am-btn"
        :disabled="!projectStore.currentPath || !importAllowedDir(currentDir)"
        title="导入文件到当前目录"
        @click="() => doImport()"
      >
        导入
      </button>
      <button
        class="am-btn"
        :disabled="!projectStore.currentPath || !importAllowedDir(currentDir)"
        title="导入文件夹到当前目录"
        @click="() => doImportFolder()"
      >
        导入目录
      </button>
      <button class="am-btn" title="刷新资产" @click="assetsStore.refresh">⟳</button>
    </div>

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

        <!-- 网格视图 -->
        <template v-if="viewMode === 'grid'">
          <div
            v-for="item in children"
            :key="item.path"
            class="am-item grid"
            :class="{ selected: selectedPaths.includes(item.path), 'drop-over': item.kind === 'dir' && item.path === hoverPath }"
            :title="item.path"
            :data-drop-dir="dropDirAttr(item)"
            @click="onItemClickGuard($event, item)"
            @dblclick="onItemDblClick(item)"
            @contextmenu.prevent.stop="onItemContext($event, item)"
            @mousedown="onItemMouseDown($event, item)"
          >
            <span class="am-icon"><AssetTypeIcon :kind="item.kind" /></span>
            <span class="am-name">{{ item.name }}</span>
          </div>
        </template>

        <!-- 列表视图 -->
        <template v-else>
          <div
            v-for="item in children"
            :key="item.path"
            class="am-item list"
            :class="{ selected: selectedPaths.includes(item.path), 'drop-over': item.kind === 'dir' && item.path === hoverPath }"
            :title="item.path"
            :data-drop-dir="dropDirAttr(item)"
            @click="onItemClickGuard($event, item)"
            @dblclick="onItemDblClick(item)"
            @contextmenu.prevent.stop="onItemContext($event, item)"
            @mousedown="onItemMouseDown($event, item)"
          >
            <span class="am-icon sm"><AssetTypeIcon :kind="item.kind" /></span>
            <span class="am-name">{{ item.name }}</span>
            <span v-if="item.relPath" class="am-rel">{{ item.relPath }}</span>
            <span v-if="item.kind !== 'dir'" class="am-kind">{{ item.kind }}</span>
            <span v-if="item.kind !== 'dir'" class="am-size">{{ fmtSize(item.size) }}</span>
          </div>
        </template>
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
