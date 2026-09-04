<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { getEditorStore } from "../stores/editor";
import type { Node } from "../../framework/prototype/Node";
import type { GeometryKind, LightNode } from "../../framework/prototype/derived/Primitives";
import type { MoveTarget } from "../../framework/command/commands";
import {
  openContextMenu,
  menuSeparator,
  type CtxMenuItem,
} from "../../lib/editor/context-menu";
import "../../styles/components/hierarchy-panel.scss";

const store = getEditorStore();
const { state, engine } = store;

const typeBadge: Record<string, string> = {
  node: "G",
  meshNode: "M",
  lightNode: "L",
  cameraNode: "C",
};

const search = ref("");
const treeEl = ref<HTMLElement | null>(null);

interface FlatNode {
  node: Node;
  depth: number;
}

const flat = computed<FlatNode[]>(() => {
  void state.selectedId;
  void state.selectionIds;
  void store.revision();
  const root = engine.graph.root;
  const out: FlatNode[] = [];
  if (!root) return out;
  const walk = (n: Node, depth: number) => {
    out.push({ node: n, depth });
    engine.graph.childrenOf(n.id).forEach((c) => walk(c, depth + 1));
  };
  walk(root, 0);
  const q = search.value.trim().toLowerCase();
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
function addNodeTo(parentId: string, type: string, name?: string): void {
  const finalName = (name ?? "").trim() || type;
  let node: Node;
  if (type.startsWith("mesh:")) {
    node = engine.addMesh(type.slice(5) as GeometryKind, parentId);
  } else if (type.startsWith("light:")) {
    node = engine.addLight(type.slice(6) as LightNode["lightKind"], parentId);
  } else if (type === "camera") {
    node = engine.addCamera(parentId);
  } else {
    node = engine.addEmptyGroup(parentId);
  }
  if (finalName !== type) engine.renameSelected(finalName);
  engine.select(node.id);
}

function createAddItems(parentId: string): CtxMenuItem[] {
  return [
    { label: "网格", header: true },
    { label: "Cube", onClick: () => addNodeTo(parentId, "mesh:box") },
    { label: "Sphere", onClick: () => addNodeTo(parentId, "mesh:sphere") },
    { label: "Cylinder", onClick: () => addNodeTo(parentId, "mesh:cylinder") },
    { label: "Plane", onClick: () => addNodeTo(parentId, "mesh:plane") },
    menuSeparator(),
    { label: "灯光", header: true },
    { label: "Point Light", onClick: () => addNodeTo(parentId, "light:point") },
    { label: "Directional Light", onClick: () => addNodeTo(parentId, "light:directional") },
    { label: "Ambient", onClick: () => addNodeTo(parentId, "light:ambient") },
    menuSeparator(),
    { label: "Camera", onClick: () => addNodeTo(parentId, "camera") },
    { label: "Group", onClick: () => addNodeTo(parentId, "group") },
  ];
}

function deleteNodes(targetIds: string[]): void {
  const root = engine.graph.root;
  let targets = targetIds.filter((id) => {
    const n = engine.graph.get(id);
    return !!n && n.id !== root?.id;
  });
  if (targets.length > 1) {
    // 剔除互为子孙的冗余项，只保留顶层，避免父删后子再删的重复
    targets = targets.filter(
      (tid) => !targets.some((other) => other !== tid && engine.graph.isDescendant(other, tid)),
    );
  }
  if (!targets.length) {
    console.warn("根场景节点不可删除");
    return;
  }
  engine.deleteNodes(targets);
}

function createItems(parentId: string): CtxMenuItem[] {
  const items: CtxMenuItem[] = [];
  items.push({ label: "添加节点", children: createAddItems(parentId) });
  items.push(menuSeparator());
  items.push({
    label: "重命名",
    onClick: () => {
      const v = window.prompt("重命名节点", state.selectedId ? engine.graph.get(state.selectedId)?.name : "");
      if (v && v.trim()) engine.renameSelected(v.trim());
    },
  });
  const isRoot = engine.graph.root?.id === parentId;
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
    dnd.target = root && !dragCandidate?.ids.includes(root.id) ? { id: root.id, mode: "inside" } : null;
    return;
  }
  const id = row.getAttribute("data-node-id");
  if (!id) return;
  if (dragCandidate?.ids.includes(id)) {
    dnd.target = null;
    return;
  }
  const rect = row.getBoundingClientRect();
  const rel = (clientY - rect.top) / rect.height;
  const mode: "before" | "after" | "inside" = rel < 0.25 ? "before" : rel > 0.75 ? "after" : "inside";
  dnd.target = { id, mode };
}

function onWindowMouseUp(): void {
  if (!dragCandidate) return;
  const ids = dragCandidate.ids;
  const t = dnd.target;
  dragCandidate = null;
  dragging = false;
  dnd.active = false;
  dnd.target = null;
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
    engine.reparentNodes(moves);
    engine.setSelection(ids);
  }
}

onMounted(() => {
  window.addEventListener("mousemove", onWindowMouseMove);
  window.addEventListener("mouseup", onWindowMouseUp);
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
        <span class="badge" :class="node.typeKey">{{ typeBadge[node.typeKey] ?? "?" }}</span>
        <span class="name">{{ node.name }}</span>
        <span v-if="!node.visible || !node.active" class="off mono">off</span>
      </div>
      <div v-if="!flat.length" class="empty muted">
        {{ search.trim() ? "无匹配节点" : "场景为空" }}
      </div>
    </div>
  </div>
</template>
