<script setup lang="ts">
import { computed } from "vue";
import { getEditorStore } from "../stores/editor";
import type { Node } from "../../framework/prototype/Node";

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

const flat = computed<FlatNode[]>(() => {
  void state.selectedId;
  void engineSelectedTrigger();
  const root = engine.graph.root;
  const out: FlatNode[] = [];
  if (!root) return out;
  const walk = (n: Node, depth: number) => {
    out.push({ node: n, depth });
    engine.graph.childrenOf(n.id).forEach((c) => walk(c, depth + 1));
  };
  walk(root, 0);
  return out;
});

function engineSelectedTrigger(): number {
  return store.revision();
}

function select(id: string): void {
  engine.select(id);
}
</script>

<template>
  <div class="panel hierarchy">
    <div class="panel__title">层级 / Hierarchy</div>
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
      <div v-if="!flat.length" class="empty muted">场景为空</div>
    </div>
  </div>
</template>

<style scoped>
.hierarchy {
  min-width: 220px;
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
  background: var(--panel-2);
}

.row.sel {
  background: rgba(77, 163, 255, 0.18);
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
  color: #06121f;
}

.badge.node {
  background: #7c8aa0;
}

.badge.meshNode {
  background: #4da3ff;
}

.badge.lightNode {
  background: #ffcf5c;
}

.badge.cameraNode {
  background: #ff7d9c;
}

.name {
  font-size: 12px;
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.off {
  margin-left: auto;
  color: var(--muted);
}

.empty {
  padding: 10px;
  font-size: 12px;
}
</style>