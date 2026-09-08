<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { getEditorStore } from "../stores/editor";
import type { Node } from "../../framework/prototype/Node";
import { geometryRegistry } from "../../framework/mesh";
import type { MoveTarget } from "../../framework/scene/SceneClient";
import {
  CAMERA_ICON_PATHS,
  MESH_ICON_PATHS,
  GROUP_ICON_PATHS,
  SKYBOX_ICON_PATHS,
  AUDIO_ICON_PATHS,
  LIGHT_POINT_ICON_PATHS,
  LIGHT_DIRECTIONAL_ICON_PATHS,
  LIGHT_AMBIENT_ICON_PATHS,
  LIGHT_SPOT_ICON_PATHS,
} from "../../framework/engine/modules/helpers/icons";
import {
  openContextMenu,
  menuSeparator,
  type CtxMenuItem,
} from "../../lib/editor/context-menu";
import { dispatchCommand } from "../commands";
import { prompt } from "../lib/prompt";
import { saveNodeAsPrefab, updatePrefabFromNode } from "../lib/prefabs";
import { getScriptsStore } from "../stores/scripts";
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

// ---------- 折叠/展开 ----------
/** 已折叠节点 id 集（仅记忆状态；缺省全部展开） */
const collapsedIds = ref(new Set<string>());

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
}
/** 拖拽悬停目标为折叠节点时自动展开（放入的子级立即可见） */
function expandIfCollapsed(id: string): void {
  if (!collapsedIds.value.has(id)) return;
  const next = new Set(collapsedIds.value);
  next.delete(id);
  collapsedIds.value = next;
}

const flat = computed<FlatNode[]>(() => {
  void state.selectedId;
  void state.selectionIds;
  void store.revision();
  const q = search.value.trim().toLowerCase();
  const root = engine.graph.root;
  const out: FlatNode[] = [];
  if (!root) return out;
  // 搜索时忽略折叠（子树中的匹配项保持可见），平时按折叠状态裁剪子级
  const walk = (n: Node, depth: number) => {
    out.push({ node: n, depth });
    if (!q && collapsedIds.value.has(n.id)) return;
    engine.graph.childrenOf(n.id).forEach((c) => walk(c, depth + 1));
  };
  walk(root, 0);
  if (!q) return out;
  return out.filter((f) => f.node.name.toLowerCase().includes(q));
});

// ---------- 选中 ----------
function isSelected(id: string): boolean {
  return state.selectedId === id;
}
function isMultiSelected(id: string): boolean {
  return state.selectionIds.length > 1 && state.selectionIds.includes(id) && state.selectedId !== id;
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
/** 把上下文菜单的节点类型串（mesh:box / light:point / script:rel …）映射为 node.add 参数 */
function addNodeArgs(type: string, parentId: string, name?: string): Record<string, unknown> {
  const args: Record<string, unknown> = { kind: "group", parentId };
  if (type.startsWith("mesh:")) {
    args.kind = "mesh";
    args.subtype = type.slice(5);
  } else if (type.startsWith("light:")) {
    args.kind = "light";
    args.subtype = type.slice(6);
  } else if (type.startsWith("skybox:")) {
    args.kind = "skybox";
    args.subtype = type.slice(7);
  } else if (type === "audio") {
    args.kind = "audio";
  } else if (type === "camera") {
    args.kind = "camera";
  } else if (type.startsWith("script:")) {
    args.kind = "script";
    args.subtype = type.slice(7);
  }
  if (name && name.trim()) args.name = name.trim();
  return args;
}

function addNodeTo(parentId: string, type: string, name?: string): void {
  void dispatchCommand("node.add", addNodeArgs(type, parentId, name));
}

function createAddItems(parentId: string): CtxMenuItem[] {
  // 基元列表由几何工厂注册表驱动（新增基元自动出现在菜单）
  const geometryItems: CtxMenuItem[] = geometryRegistry.list().map((g) => ({
    label: g.label,
    onClick: () => addNodeTo(parentId, `mesh:${g.key}`),
  }));
  // 脚本节点类型：脚本类用 static nodeType 声明的可创建节点
  const scriptNodeItems: CtxMenuItem[] = scriptsStore.scriptNodeTypes().map((s) => ({
    label: s.name,
    onClick: () => addNodeTo(parentId, `script:${s.rel}`),
  }));
  const items: CtxMenuItem[] = [];
  items.push({ label: "网格", children: geometryItems });
  items.push(menuSeparator());
  items.push({
    label: "灯光",
    children: [
      { label: "Point Light", onClick: () => addNodeTo(parentId, "light:point") },
      { label: "Directional Light", onClick: () => addNodeTo(parentId, "light:directional") },
      { label: "Spot Light", onClick: () => addNodeTo(parentId, "light:spot") },
      { label: "Ambient", onClick: () => addNodeTo(parentId, "light:ambient") },
    ],
  });
  items.push(menuSeparator());
  items.push({ label: "Camera", onClick: () => addNodeTo(parentId, "camera") });
  items.push({ label: "Group", onClick: () => addNodeTo(parentId, "group") });
  items.push({ label: "Audio Source", onClick: () => addNodeTo(parentId, "audio") });
  items.push(menuSeparator());
  items.push({
    label: "天空盒",
    children: [
      { label: "Procedural Skybox", onClick: () => addNodeTo(parentId, "skybox:procedural") },
      { label: "Cube Skybox", onClick: () => addNodeTo(parentId, "skybox:cube") },
    ],
  });
  if (scriptNodeItems.length) {
    items.push(menuSeparator());
    items.push({ label: "脚本节点", children: scriptNodeItems });
  }
  return items;
}

function deleteNodes(targetIds: string[]): void {
  void dispatchCommand("node.delete", { ids: targetIds });
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
  // 预读脚本元数据（@nodeType / @property）：让「脚本节点」创建菜单开箱可用
  void scriptsStore.prefetchScriptMetas();
});
onUnmounted(() => {
  window.removeEventListener("mousemove", onWindowMouseMove);
  window.removeEventListener("mouseup", onWindowMouseUp);
});
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
        {{ search.trim() ? "无匹配节点" : "场景为空" }}
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
