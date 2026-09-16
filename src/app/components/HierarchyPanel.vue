<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { getEditorStore } from "../stores/editor";
import { getProjectStore } from "../stores/project";
import { sceneApi } from "../../lib/scene-api";
import { uiStateGet, uiStateSet } from "../../lib/ui-state";
import type { Node } from "../../framework/prototype/Node";
import { geometryRegistry } from "../../framework/mesh";
import type { MoveTarget } from "../../framework/scene/SceneClient";
import {
  CAMERA_ICON_PATHS,
  MESH_ICON_PATHS,
  GROUP_ICON_PATHS,
  SKYBOX_ICON_PATHS,
  AUDIO_ICON_PATHS,
  PARTICLE_ICON_PATHS,
  TERRAIN_ICON_PATHS,
  FOG_ICON_PATHS,
  LIGHT_POINT_ICON_PATHS,
  LIGHT_DIRECTIONAL_ICON_PATHS,
  LIGHT_AMBIENT_ICON_PATHS,
  LIGHT_SPOT_ICON_PATHS,
  UI_CANVAS_ICON_PATHS,
  UI_IMAGE_ICON_PATHS,
  UI_TEXT_ICON_PATHS,
  UI_BUTTON_ICON_PATHS,
  UI_LAYOUT_ICON_PATHS,
  NAV_AREA_ICON_PATHS,
  NAV_AGENT_ICON_PATHS,
  FSM_RUNNER_ICON_PATHS,
  BT_RUNNER_ICON_PATHS,
} from "../../framework/engine/modules/helpers/icons";
import {
  openContextMenu,
  menuSeparator,
  type CtxMenuItem,
} from "../../lib/editor/context-menu";
import { dispatchCommand } from "../commands";
import {
  addNodeArgs,
  addNodeMenuItems,
  type AddMenuItem,
} from "../lib/node-menu";
import { prompt } from "../lib/prompt";
import { saveNodeAsPrefab, updatePrefabFromNode } from "../lib/prefabs";
import { getScriptsStore } from "../stores/scripts";
import { animEditMode, collectSubtreeIds } from "../lib/anim-edit-mode";
import "../../styles/components/hierarchy-panel.scss";

const store = getEditorStore();
const { state, engine } = store;
const scriptsStore = getScriptsStore();

/** 节点类型 → SVG 图标路径 + 颜色（与引擎视口/资产图标共用同一份路径数据） */
const NODE_ICONS: Record<string, { d: string[]; color: string }> = {
  node: { d: GROUP_ICON_PATHS, color: "#9aa4b2" },
  meshNode: { d: MESH_ICON_PATHS, color: "#8ab4f8" },
  cameraNode: { d: CAMERA_ICON_PATHS, color: "#4fc3f7" },
  lightNode: { d: LIGHT_POINT_ICON_PATHS, color: "#ffb84d" },
  pointLightNode: { d: LIGHT_POINT_ICON_PATHS, color: "#ffb84d" },
  directionalLightNode: { d: LIGHT_DIRECTIONAL_ICON_PATHS, color: "#ffd166" },
  ambientLightNode: { d: LIGHT_AMBIENT_ICON_PATHS, color: "#4dd0a1" },
  spotLightNode: { d: LIGHT_SPOT_ICON_PATHS, color: "#ff9f43" },
  skyboxNode: { d: SKYBOX_ICON_PATHS, color: "#8ecae6" },
  audioNode: { d: AUDIO_ICON_PATHS, color: "#7ed49a" },
  particleSystemNode: { d: PARTICLE_ICON_PATHS, color: "#e0a0ff" },
  terrainNode: { d: TERRAIN_ICON_PATHS, color: "#7fbf7f" },
  fogNode: { d: FOG_ICON_PATHS, color: "#b7c6d6" },
  navAreaNode: { d: NAV_AREA_ICON_PATHS, color: "#9fd48a" },
  navAgentNode: { d: NAV_AGENT_ICON_PATHS, color: "#6fd6ff" },
  fsmRunnerNode: { d: FSM_RUNNER_ICON_PATHS, color: "#569cd6" },
  btRunnerNode: { d: BT_RUNNER_ICON_PATHS, color: "#dcdcaa" },
  uiCanvasNode: { d: UI_CANVAS_ICON_PATHS, color: "#f4a261" },
  uiImageNode: { d: UI_IMAGE_ICON_PATHS, color: "#90be6d" },
  uiTextNode: { d: UI_TEXT_ICON_PATHS, color: "#6ea8fe" },
  uiButtonNode: { d: UI_BUTTON_ICON_PATHS, color: "#ff70a6" },
  uiLayoutNode: { d: UI_LAYOUT_ICON_PATHS, color: "#a78bfa" },
};

const FALLBACK_BADGE: Record<string, string> = {
  node: "G",
  meshNode: "M",
  lightNode: "L",
  pointLightNode: "P",
  directionalLightNode: "D",
  ambientLightNode: "A",
  spotLightNode: "S",
  cameraNode: "C",
  skyboxNode: "SK",
  audioNode: "AU",
  particleSystemNode: "FX",
  terrainNode: "T",
  fogNode: "F",
  navAreaNode: "NA",
  navAgentNode: "AG",
  fsmRunnerNode: "FS",
  btRunnerNode: "BE",
  uiCanvasNode: "UI",
  uiImageNode: "IM",
  uiTextNode: "TX",
  uiButtonNode: "BT",
  uiLayoutNode: "LO",
};

/** 预制体实例：图标统一绿色（与其他对象区分；仅实例根节点带 prefab 来源引用） */
const PREFAB_ICON_COLOR = "#35c26f";

function nodeIconColor(node: Node): string {
  return node.prefab ? PREFAB_ICON_COLOR : (NODE_ICONS[node.typeKey]?.color ?? "");
}

// ---------- 可见性（小眼睛） ----------
const EYE_PATHS = [
  "M2.5 12s3.5-6.2 9.5-6.2 9.5 6.2 9.5 6.2-3.5 6.2-9.5 6.2S2.5 12 2.5 12z",
  "M12 14.8a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6z",
];
const EYE_OFF_PATHS = [...EYE_PATHS, "M4.5 4.5l15 15"];

/** 眼睛状态 = 实际是否渲染（可见 且 激活） */
function isEyeOn(node: Node): boolean {
  return node.visible && node.active;
}

/** 眼睛点击：渲染中 → 隐藏（visible=false）；隐藏中 → 显示并恢复激活（一步到位） */
function toggleVisible(node: Node): void {
  const value = !isEyeOn(node);
  const before = node.toJSON() as Record<string, unknown>;
  node.visible = value;
  if (value) node.active = true;
  const after = node.toJSON() as Record<string, unknown>;
  void dispatchCommand("node.patch", {
    id: node.id,
    before,
    after,
    label: value ? "显示节点" : "隐藏节点",
  });
}

const search = ref("");
const treeEl = ref<HTMLElement | null>(null);

interface FlatNode {
  node: Node;
  depth: number;
}

// ---------- 折叠/展开（按 项目+场景 持久化；重开编辑器/工程后还原） ----------
const projectStore = getProjectStore();

/** 已折叠节点 id 集（缺省全部展开；后端 UI 状态 KV，键 = 项目根 + 场景相对路径，
 *  节点 id 随场景文件持久化，跨会话稳定） */
const collapsedIds = ref(new Set<string>());
const collapsedKey = computed(
  () => `tve:editor:hierarchy-collapse:${projectStore.currentPath ?? ""}::${projectStore.sceneRel}`,
);
let persistTimer: ReturnType<typeof setTimeout> | null = null;

async function loadCollapsed(): Promise<void> {
  // 取消未落盘的旧写入（防止上个场景的折叠态写进新键）
  if (persistTimer != null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const ids = await uiStateGet<string[]>(collapsedKey.value);
  collapsedIds.value = new Set(Array.isArray(ids) ? ids : []);
}

function persistCollapsed(): void {
  if (persistTimer != null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void uiStateSet(collapsedKey.value, [...collapsedIds.value]);
  }, 300);
}

// 项目/场景切换 → 载入对应折叠态（面板挂载时也立即执行）
watch(collapsedKey, () => void loadCollapsed(), { immediate: true });

function hasChildren(node: Node): boolean {
  return node.childIds.length > 0;
}
function isCollapsed(node: Node): boolean {
  return collapsedIds.value.has(node.id);
}
function toggleCollapse(node: Node): void {
  if (!hasChildren(node)) return;
  const next = new Set(collapsedIds.value);
  if (next.has(node.id)) next.delete(node.id);
  else next.add(node.id);
  collapsedIds.value = next;
  persistCollapsed();
}
/** 拖拽悬停目标为折叠节点时自动展开（放入的子级立即可见） */
function expandIfCollapsed(id: string): void {
  if (!collapsedIds.value.has(id)) return;
  const next = new Set(collapsedIds.value);
  next.delete(id);
  collapsedIds.value = next;
  persistCollapsed();
}

// ---------- 行数据源（后端计算） ----------
// 展平/域过滤/搜索都在 Rust 权威图上单次 DFS 完成（scene_hierarchy_rows），
// 前端不再随图变更做全树 O(n·depth) 逐节点父链回溯——大量节点下拖动/编辑
// 不再卡层级面板。触发：图变更（防抖合并 gizmo 连续提交）、视图切换、搜索。
interface BackendRow {
  id: string;
  depth: number;
}
const backendRows = ref<BackendRow[]>([]);
let fetchSeq = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let unsubGraphChanged: (() => void) | null = null;

function scheduleRowRefresh(): void {
  if (refreshTimer != null) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshRows();
  }, 120);
}

async function refreshRows(): Promise<void> {
  const seq = ++fetchSeq;
  try {
    const res = await sceneApi.hierarchyRows(
      state.viewMode === "layout" ? "layout" : "scene",
      search.value.trim().toLowerCase(),
    );
    if (seq !== fetchSeq) return; // 过期响应丢弃（防抖期间参数又变）
    backendRows.value = res.rows.map((r) => ({ id: r.id, depth: r.depth }));
  } catch {
    /* 会话未开/后端不可用：保留旧行（未装载场景本就无行） */
  }
}

onMounted(() => {
  // 图变更（增删/重父级/重命名/可见性）→ 防抖刷新
  unsubGraphChanged = engine.events.on("graph:changed", scheduleRowRefresh);
  void refreshRows();
});

const flat = computed<FlatNode[]>(() => {
  void state.selectedId;
  void state.selectionIds;
  void store.revision();
  const q = search.value.trim().toLowerCase();
  // 折叠裁剪（后端行按 DFS 序带显示深度，深度栈跳过折叠子树）；
  // 搜索时忽略折叠（旧行为：子树中的匹配项保持可见）。
  // 镜像节点 O(1) 回填：模板/右键/拖拽处理器仍消费完整 Node。
  const out: FlatNode[] = [];
  let collapsedAt = Number.POSITIVE_INFINITY;
  for (const row of backendRows.value) {
    if (row.depth <= collapsedAt) collapsedAt = Number.POSITIVE_INFINITY;
    if (row.depth > collapsedAt) continue;
    if (!q && collapsedIds.value.has(row.id)) collapsedAt = row.depth;
    const node = engine.graph.get(row.id);
    if (node) out.push({ node, depth: row.depth });
  }
  return out;
});

// ---------- 选中 ----------
function isSelected(id: string): boolean {
  return state.selectedId === id;
}
function isMultiSelected(id: string): boolean {
  return state.selectionIds.length > 1 && state.selectionIds.includes(id) && state.selectedId !== id;
}

// ---------- 动画聚焦编辑：层级高亮目标子树、置灰其它 ----------
const editRootId = computed(() => (animEditMode.active ? animEditMode.rootId : ""));
const editSubtreeIds = computed(() => {
  void animEditMode.active;
  void store.revision();
  const rootId = editRootId.value;
  if (!rootId) return new Set<string>();
  return new Set(collectSubtreeIds(engine.graph, rootId));
});
/** 编辑中：属于目标子树 → 高亮；否则置灰 */
function inEditSubtree(id: string): boolean {
  return editRootId.value !== "" && editSubtreeIds.value.has(id);
}
function isEditRoot(id: string): boolean {
  return editRootId.value !== "" && editRootId.value === id;
}

function visibleNodeIds(): string[] {
  const ids: string[] = [];
  treeEl.value?.querySelectorAll<HTMLElement>(".node-row[data-node-id]").forEach((el) => {
    const id = el.getAttribute("data-node-id");
    if (id) ids.push(id);
  });
  return ids;
}

function doSelect(id: string, ev?: MouseEvent): void {
  if (ev?.shiftKey && state.selectedId) {
    const ids = visibleNodeIds();
    const a = ids.indexOf(state.selectedId);
    const b = ids.indexOf(id);
    if (a >= 0 && b >= 0) {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      engine.setSelection(ids.slice(lo, hi + 1));
      return;
    }
  }
  if (ev?.ctrlKey || ev?.metaKey) {
    engine.toggleSelection(id);
    return;
  }
  engine.select(id);
}

function onRowClick(id: string, ev: MouseEvent): void {
  if (Date.now() < suppressClickUntil) {
    ev.preventDefault();
    return;
  }
  doSelect(id, ev);
}

// ---------- 添加 / 删除 ----------
function addNodeTo(parentId: string, type: string, name?: string): void {
  // 类型串 → node.add 参数（菜单项与映射表由 lib/node-menu 统一定义，未知类型串提示而不是静默兜底）
  const args = addNodeArgs(type, parentId, name);
  if (!args) {
    console.warn(`未知节点类型: ${type}（菜单项与 node-menu 映射表不同步）`);
    return;
  }
  void dispatchCommand("node.add", args);
}

function createAddItems(parentId: string): CtxMenuItem[] {
  const defs = addNodeMenuItems({
    geometry: geometryRegistry.list().map((g) => ({ key: g.key, label: g.label })),
    scripts: scriptsStore.scriptNodeTypes().map((s) => ({ rel: s.rel, name: s.name })),
  });
  // 菜单项定义 → 上下文菜单项（叶子项点击即按类型串新增节点）
  const leafItem = (def: AddMenuItem): CtxMenuItem => ({
    label: def.label ?? "",
    onClick: () => addNodeTo(parentId, def.type as string),
  });
  return defs.map((def): CtxMenuItem => {
    if (def.separator) return menuSeparator();
    if (def.children) {
      return { label: def.label ?? "", children: def.children.map(leafItem) };
    }
    return leafItem(def);
  });
}

function deleteNodes(targetIds: string[]): void {
  void dispatchCommand("node.delete", { ids: targetIds });
}

function duplicateNodes(targetIds: string[]): void {
  void dispatchCommand("node.duplicate", { ids: targetIds });
}

/** 存储节点子树为预制体资产（弹名输入；assets/prefabs/ 下去重） */
async function doSaveAsPrefab(nodeId: string): Promise<void> {
  const node = engine.graph.get(nodeId);
  if (!node) return;
  const name = await prompt({
    title: "存储为预制体",
    label: "预制体名（创建在 assets/prefabs/）",
    initial: node.name,
    confirmText: "存储",
  });
  if (!name?.trim()) return;
  await saveNodeAsPrefab(nodeId, name.trim());
}

function createItems(parentId: string): CtxMenuItem[] {
  const items: CtxMenuItem[] = [];
  items.push({ label: "添加节点", children: createAddItems(parentId) });
  items.push(menuSeparator());
  items.push({
    label: "重命名",
    onClick: () => {
      // 弹统一输入框重命名选中节点（与 F2 快捷键同一条命令）
      void dispatchCommand("node.renameSelected");
    },
  });
  const isRoot = engine.graph.root?.id === parentId;
  items.push({
    label: "复制",
    disabled: isRoot,
    onClick: () => {
      const multi = state.selectionIds.length > 1 && state.selectionIds.includes(parentId);
      duplicateNodes(multi ? [...state.selectionIds] : [parentId]);
    },
  });
  // 相机节点：把位姿与取景参数对齐到当前编辑器视口（Align With View）
  if (engine.graph.get(parentId)?.typeKey === "cameraNode") {
    items.push({
      label: "对齐到当前视口",
      onClick: () => void dispatchCommand("node.alignCameraToViewport", { id: parentId }),
    });
  }
  // 预制体：把子树存为 .prefab 资产；实例（带来源引用）可回写更新资产
  items.push({
    label: "存储为预制体…",
    disabled: isRoot,
    onClick: () => void doSaveAsPrefab(parentId),
  });
  const sourceRel = engine.graph.get(parentId)?.prefab ?? "";
  if (sourceRel) {
    items.push({
      label: "更新预制体（" + (sourceRel.split("/").pop() ?? sourceRel) + "）",
      onClick: () => void updatePrefabFromNode(parentId),
    });
  }
  items.push({
    label: "删除",
    danger: true,
    disabled: isRoot,
    onClick: () => {
      const multi = state.selectionIds.length > 1 && state.selectionIds.includes(parentId);
      deleteNodes(multi ? [...state.selectionIds] : [parentId]);
    },
  });
  return items;
}

function onNodeContext(e: MouseEvent, id: string): void {
  e.preventDefault();
  e.stopPropagation();
  if (!(state.selectionIds.length > 1 && state.selectionIds.includes(id))) engine.select(id);
  openContextMenu(e, createItems(id));
}

function onBlankContext(e: MouseEvent): void {
  e.preventDefault();
  e.stopPropagation();
  engine.select(null);
  const root = engine.graph.root;
  const items: CtxMenuItem[] = [];
  if (root) items.push({ label: "添加到根节点", children: createAddItems(root.id) });
  openContextMenu(e, items);
}

// ---------- 指针式拖拽移动 ----------
const DRAG_THRESHOLD = 5;
let dragCandidate: { ids: string[]; x: number; y: number } | null = null;
let dragging = false;
let suppressClickUntil = 0;

const dnd = reactive<{
  active: boolean;
  target: { id: string; mode: "before" | "after" | "inside" } | null;
}>({ active: false, target: null });

const dragGhost = ref<{ x: number; y: number; label: string } | null>(null);

function ghostLabel(): string {
  if (!dragCandidate) return "";
  const first = engine.graph.get(dragCandidate.ids[0]);
  return first?.name ?? "";
}

function onRowMouseDown(e: MouseEvent, id: string): void {
  if (e.button !== 0) return;
  const root = engine.graph.root;
  if (!root || id === root.id) return;
  const multi = state.selectionIds.length > 1 && state.selectionIds.includes(id);
  const ids = multi ? [...state.selectionIds] : [id];
  dragCandidate = { ids, x: e.clientX, y: e.clientY };
  dragging = false;
}

function onWindowMouseMove(e: MouseEvent): void {
  if (!dragCandidate) return;
  if (!dragging) {
    const dx = e.clientX - dragCandidate.x;
    const dy = e.clientY - dragCandidate.y;
    if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
    dragging = true;
    suppressClickUntil = Date.now() + 120;
    dnd.active = true;
  }
  resolveDrop(e.clientX, e.clientY);
  dragGhost.value = { x: e.clientX, y: e.clientY, label: ghostLabel() };
}

function resolveDrop(clientX: number, clientY: number): void {
  const root = engine.graph.root;
  const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
  // 只在层级面板内接受拖放：拖出面板外视为无效
  if (!treeEl.value || !el || !treeEl.value.contains(el)) {
    dnd.target = null;
    return;
  }
  const row = el.closest?.(".node-row[data-node-id]") as HTMLElement | null;
  if (!row || !root) {
    dnd.target = root ? { id: root.id, mode: "inside" } : null;
    return;
  }
  const id = row.getAttribute("data-node-id");
  if (!id) return;
  if (dragCandidate?.ids.includes(id)) {
    dnd.target = null;
    return;
  }
  // 拖到根节点行或面板空白处 → 收进根节点成为其子级
  if (id === root.id) {
    dnd.target = { id: root.id, mode: "inside" };
    return;
  }
  const rect = row.getBoundingClientRect();
  const rel = (clientY - rect.top) / rect.height;
  const mode: "before" | "after" | "inside" = rel < 0.25 ? "before" : rel > 0.75 ? "after" : "inside";
  dnd.target = { id, mode };
  if (mode === "inside") expandIfCollapsed(id);
}

function onWindowMouseUp(): void {
  if (!dragCandidate) return;
  const ids = dragCandidate.ids;
  const t = dnd.target;
  dragCandidate = null;
  dragging = false;
  dnd.active = false;
  dnd.target = null;
  dragGhost.value = null;
  if (!t || !t.id) return;
  applyMove(ids, t.id, t.mode);
}

function moveMoves(ids: string[], newParentId: string, newIndex: number): MoveTarget[] | null {
  const moves: MoveTarget[] = [];
  for (const dId of ids) {
    const n = engine.graph.get(dId);
    if (!n || n.isRoot) continue;
    // 成环：新父是被拖节点自身或其子孙（拖入自身子树）
    if (newParentId === dId || engine.graph.isDescendant(dId, newParentId)) {
      console.warn("无法移动：不能拖入自身或其子孙节点");
      return null;
    }
    moves.push({ id: dId, newParentId, newIndex });
  }
  return moves.length ? moves : null;
}

function applyMove(ids: string[], targetId: string, mode: "before" | "after" | "inside"): void {
  const target = engine.graph.get(targetId);
  if (!target) return;
  let newParentId: string;
  let newIndex: number;
  if (mode === "inside" || !target.parentId) {
    // 目标行是根（无父）或要求降级为子级 → 直接收进目标行
    newParentId = targetId;
    newIndex = -1;
  } else {
    const parent = engine.graph.get(target.parentId);
    if (!parent) return;
    newParentId = parent.id;
    newIndex = parent.childIds.indexOf(targetId) + (mode === "after" ? 1 : 0);
  }
  const batch = ids.length > 1;
  const moves = moveMoves(ids, newParentId, batch ? -1 : newIndex);
  if (moves) {
    void dispatchCommand("node.reparent", { moves, selectIds: ids });
  }
}

onMounted(() => {
  window.addEventListener("mousemove", onWindowMouseMove);
  window.addEventListener("mouseup", onWindowMouseUp);
  // 预读脚本元数据（@nodeType / @property）：让「脚本节点」创建菜单开箱可用。
  // 首次解析会拉起 TypeScript 编译器（数 MB 懒加载 chunk + 全量 AST 解析），
  // 推迟到浏览器空闲再跑，避免拖慢面板首帧与项目打开链路。
  const idle = (cb: () => void) =>
    "requestIdleCallback" in window
      ? requestIdleCallback(() => cb(), { timeout: 3000 })
      : setTimeout(cb, 1200);
  idle(() => void scriptsStore.prefetchScriptMetas());
});
onUnmounted(() => {
  window.removeEventListener("mousemove", onWindowMouseMove);
  window.removeEventListener("mouseup", onWindowMouseUp);
  unsubGraphChanged?.();
  unsubGraphChanged = null;
  if (refreshTimer != null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  // 未落盘的折叠态立即写入（面板卸载后定时器不再触发）
  if (persistTimer != null) {
    clearTimeout(persistTimer);
    persistTimer = null;
    void uiStateSet(collapsedKey.value, [...collapsedIds.value]);
  }
});

// 视图切换（场景树 ↔ UI 树）与搜索输入都改变行集 → 防抖拉取
watch(
  () => state.viewMode,
  () => scheduleRowRefresh(),
);
watch(search, () => scheduleRowRefresh());
</script>

<template>
  <div class="panel hierarchy">
    <div class="h-actions">
      <input v-model="search" class="h-search" placeholder="搜索节点…" />
    </div>

    <div ref="treeEl" class="tree" @contextmenu.prevent="onBlankContext">
      <div
        v-for="{ node, depth } in flat"
        :key="node.id"
        class="node-row"
        :data-node-id="node.id"
        :class="{
          sel: isSelected(node.id),
          'multi-sel': isMultiSelected(node.id),
          'drop-inside': dnd.active && dnd.target?.id === node.id && dnd.target.mode === 'inside',
          'drop-before': dnd.active && dnd.target?.id === node.id && dnd.target.mode === 'before',
          'drop-after': dnd.active && dnd.target?.id === node.id && dnd.target.mode === 'after',
          'edit-dim': editRootId !== '' && !inEditSubtree(node.id),
          'edit-hl': inEditSubtree(node.id),
          'edit-root': isEditRoot(node.id),
        }"
        :style="{ paddingLeft: 8 + depth * 14 + 'px' }"
        @mousedown="onRowMouseDown($event, node.id)"
        @click="onRowClick(node.id, $event)"
        @contextmenu.prevent="onNodeContext($event, node.id)"
      >
        <span
          class="h-caret"
          :class="{ leaf: !hasChildren(node) }"
          :title="hasChildren(node) ? (isCollapsed(node) ? '展开子级' : '折叠子级') : ''"
          @click.stop="toggleCollapse(node)"
        >{{ hasChildren(node) ? (isCollapsed(node) ? "▸" : "▾") : "" }}</span>
        <span
          class="badge"
          :class="[node.typeKey, { prefab: !!node.prefab }]"
          :style="{ color: nodeIconColor(node) }"
        >
          <svg
            v-if="NODE_ICONS[node.typeKey]"
            class="badge-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path v-for="d in NODE_ICONS[node.typeKey].d" :key="d" :d="d" />
          </svg>
          <template v-else>{{ FALLBACK_BADGE[node.typeKey] ?? "?" }}</template>
        </span>
        <span class="name">{{ node.name }}</span>
        <button
          class="h-eye"
          :class="{ off: !isEyeOn(node) }"
          :title="isEyeOn(node) ? '隐藏（子级随对象树一并隐藏）' : '已隐藏，点击显示'"
          @click.stop="toggleVisible(node)"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path v-for="d in isEyeOn(node) ? EYE_PATHS : EYE_OFF_PATHS" :key="d" :d="d" />
          </svg>
        </button>
      </div>
      <div v-if="!flat.length" class="empty muted">
        {{
          search.trim()
            ? "无匹配节点"
            : state.viewMode === "layout"
              ? "场景中没有 UI 画布（回到场景视图创建画布后自动进入布局）"
              : "场景为空"
        }}
      </div>
    </div>

    <!-- 拖拽跟随幽灵（teleport 到 body：虚线框 + 节点名称） -->
    <teleport to="body">
      <div
        v-if="dragGhost"
        class="hierarchy-drag-ghost"
        :style="{ left: dragGhost.x + 'px', top: dragGhost.y + 'px' }"
      >
        <span>{{ dragGhost.label }}</span>
      </div>
    </teleport>
  </div>
</template>
