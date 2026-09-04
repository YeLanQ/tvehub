<script setup lang="ts">
import { computed, ref } from "vue";
import { getEditorStore } from "../stores/editor";
import type { Node } from "../../framework/prototype/Node";
import type { GeometryKind, LightNode } from "../../framework/prototype/derived/Primitives";

const store = getEditorStore();
const { state, engine } = store;

const typeBadge: Record<string, string> = {
  node: "G",
  meshNode: "M",
  lightNode: "L",
  cameraNode: "C",
};

interface FlatNode {
  node: Node;
  depth: number;
}

const query = ref("");

const flat = computed<FlatNode[]>(() => {
  void state.selectedId;
  void store.revision();
  const root = engine.graph.root;
  const out: FlatNode[] = [];
  if (!root) return out;
  const walk = (n: Node, depth: number) => {
    out.push({ node: n, depth });
    engine.graph.childrenOf(n.id).forEach((c) => walk(c, depth + 1));
  };
  walk(root, 0);
  const q = query.value.trim().toLowerCase();
  if (!q) return out;
  return out.filter((f) => f.node.name.toLowerCase().includes(q));
});

function engineSelectedTrigger(): number {
  return store.revision();
}

function select(id: string): void {
  engine.select(id);
}

const addOpen = ref(false);
const addType = ref<string>("mesh:box");
const addName = ref("");

const parentLabel = computed(() => {
  void engineSelectedTrigger();
  const sel = state.selectedId ? engine.graph.get(state.selectedId) : null;
  return sel ? sel.name : "Scene Root";
});

function toggleAdd(): void {
  addOpen.value = !addOpen.value;
}

function submitAdd(): void {
  const [kind, sub] = addType.value.split(":");
  if (kind === "mesh") engine.addMesh(sub as GeometryKind);
  else if (kind === "light") engine.addLight(sub as LightNode["lightKind"]);
  else if (kind === "camera") engine.addCamera();
  else engine.addEmptyGroup();
  const name = addName.value.trim();
  if (name) engine.renameSelected(name);
  addName.value = "";
  addOpen.value = false;
}
</script>

<template>
  <div class="panel hierarchy">
    <div class="h-actions">
      <input
        v-model="query"
        class="h-search"
        placeholder="搜索节点…"
      />
      <button class="h-add" :class="{ active: addOpen }" title="新建节点" @click="toggleAdd">＋</button>
    </div>

    <div v-if="addOpen" class="add-panel">
      <div class="add-row">
        <select v-model="addType" class="add-select">
          <optgroup label="网格">
            <option value="mesh:box">Cube</option>
            <option value="mesh:sphere">Sphere</option>
            <option value="mesh:cylinder">Cylinder</option>
            <option value="mesh:plane">Plane</option>
          </optgroup>
          <optgroup label="灯光">
            <option value="light:point">Point Light</option>
            <option value="light:directional">Directional Light</option>
            <option value="light:ambient">Ambient</option>
          </optgroup>
          <optgroup label="其他">
            <option value="camera">Camera</option>
            <option value="group">Group</option>
          </optgroup>
        </select>
      </div>
      <div class="add-row">
        <input
          v-model="addName"
          class="add-input"
          placeholder="名称（可选）"
          @keyup.enter="submitAdd"
        />
        <button class="add-submit" @click="submitAdd">添加</button>
      </div>
      <div class="hint">添加到：{{ parentLabel }}</div>
    </div>

    <div class="tree mono">
      <div
        v-for="{ node, depth } in flat"
        :key="node.id"
        class="row"
        :class="{ sel: node.id === state.selectedId }"
        :style="{ paddingLeft: 8 + depth * 14 + 'px' }"
        @click="select(node.id)"
      >
        <span class="badge" :class="node.typeKey">{{ typeBadge[node.typeKey] ?? "?" }}</span>
        <span class="name">{{ node.name }}</span>
        <span v-if="!node.visible || !node.active" class="off mono">off</span>
      </div>
      <div v-if="!flat.length" class="empty muted">
        {{ query.trim() ? "无匹配节点" : "场景为空" }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.hierarchy {
  min-width: 220px;
}

.h-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px;
  border-bottom: 1px solid var(--border);
}

.h-search {
  flex: 1;
  min-width: 0;
  height: 24px;
  padding: 0 8px;
  font-size: 12px;
  color: var(--text);
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 3px;
  outline: none;
}

.h-search:focus {
  border-color: var(--accent);
}

.h-add {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  padding: 0;
  font-size: 15px;
  line-height: 1;
  color: var(--text);
  background: var(--bg-panel-2);
  border: 1px solid var(--border);
  border-radius: 3px;
  cursor: pointer;
}

.h-add:hover {
  background: var(--bg-hover);
}

.h-add.active {
  background: var(--bg-active);
  border-color: var(--accent);
}

.add-panel {
  padding: 8px 6px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.add-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.add-select,
.add-input {
  flex: 1;
  min-width: 0;
  height: 24px;
  padding: 0 6px;
  font-size: 12px;
  color: var(--text);
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 3px;
  outline: none;
}

.add-select:focus,
.add-input:focus {
  border-color: var(--accent);
}

.add-submit {
  flex-shrink: 0;
  height: 24px;
  padding: 0 12px;
  font-size: 12px;
  color: var(--text);
  background: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 3px;
  cursor: pointer;
}

.add-submit:hover {
  filter: brightness(1.15);
}

.hint {
  font-size: 11px;
  color: var(--text-dim);
}

.tree {
  overflow: auto;
  flex: 1;
  padding: 4px 0;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  cursor: pointer;
  border: none;
  background: transparent;
  width: 100%;
  text-align: left;
  border-radius: 0;
}

.row:hover {
  background: var(--bg-hover);
}

.row.sel {
  background: var(--bg-active);
}

.badge {
  display: inline-block;
  width: 16px;
  height: 16px;
  line-height: 16px;
  text-align: center;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  color: #1a1a1a;
}

.badge.node {
  background: #6a6a6a;
}

.badge.meshNode {
  background: #9a9a9a;
}

.badge.lightNode {
  background: #8a8a8a;
}

.badge.cameraNode {
  background: #7a7a7a;
}

.name {
  font-size: 12px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.off {
  margin-left: auto;
  color: var(--text-dim);
}

.empty {
  padding: 10px;
  font-size: 12px;
}
</style>
