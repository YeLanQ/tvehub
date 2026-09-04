<script setup lang="ts">
import { computed, ref } from "vue";
import { getEditorStore } from "../stores/editor";
import type { Node } from "../../framework/prototype/Node";
import type { GeometryKind, LightNode } from "../../framework/prototype/derived/Primitives";
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

function select(id: string): void {
  engine.select(id);
}

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

function createItems(parentId: string): CtxMenuItem[] {
  const items: CtxMenuItem[] = [];
  items.push({
    label: "添加节点",
    children: [
      {
        label: "网格",
        header: true,
      },
      {
        label: "Cube",
        onClick: () => addNodeTo(parentId, "mesh:box"),
      },
      {
        label: "Sphere",
        onClick: () => addNodeTo(parentId, "mesh:sphere"),
      },
      {
        label: "Cylinder",
        onClick: () => addNodeTo(parentId, "mesh:cylinder"),
      },
      {
        label: "Plane",
        onClick: () => addNodeTo(parentId, "mesh:plane"),
      },
      menuSeparator(),
      {
        label: "灯光",
        header: true,
      },
      {
        label: "Point Light",
        onClick: () => addNodeTo(parentId, "light:point"),
      },
      {
        label: "Directional Light",
        onClick: () => addNodeTo(parentId, "light:directional"),
      },
      {
        label: "Ambient",
        onClick: () => addNodeTo(parentId, "light:ambient"),
      },
      menuSeparator(),
      {
        label: "Camera",
        onClick: () => addNodeTo(parentId, "camera"),
      },
      {
        label: "Group",
        onClick: () => addNodeTo(parentId, "group"),
      },
    ],
  });
  items.push(menuSeparator());
  items.push({
    label: "重命名",
    onClick: () => {
      const v = window.prompt("重命名节点", state.selectedId ? engine.graph.get(state.selectedId)?.name : "");
      if (v && v.trim()) engine.renameSelected(v.trim());
    },
  });
  items.push({
    label: "删除",
    danger: true,
    onClick: () => engine.deleteSelected(),
  });
  return items;
}

function onNodeContext(e: MouseEvent, id: string): void {
  e.preventDefault();
  e.stopPropagation();
  select(id);
  openContextMenu(e, createItems(id));
}

function onBlankContext(e: MouseEvent): void {
  e.preventDefault();
  e.stopPropagation();
  engine.select(null);
  const root = engine.graph.root;
  const items: CtxMenuItem[] = [];
  if (root) {
    items.push({
      label: "添加到根节点",
      children: [
        {
          label: "网格",
          header: true,
        },
        {
          label: "Cube",
          onClick: () => addNodeTo(root.id, "mesh:box"),
        },
        {
          label: "Sphere",
          onClick: () => addNodeTo(root.id, "mesh:sphere"),
        },
        {
          label: "Cylinder",
          onClick: () => addNodeTo(root.id, "mesh:cylinder"),
        },
        {
          label: "Plane",
          onClick: () => addNodeTo(root.id, "mesh:plane"),
        },
        menuSeparator(),
        {
          label: "灯光",
          header: true,
        },
        {
          label: "Point Light",
          onClick: () => addNodeTo(root.id, "light:point"),
        },
        {
          label: "Directional Light",
          onClick: () => addNodeTo(root.id, "light:directional"),
        },
        {
          label: "Ambient",
          onClick: () => addNodeTo(root.id, "light:ambient"),
        },
        menuSeparator(),
        {
          label: "Camera",
          onClick: () => addNodeTo(root.id, "camera"),
        },
        {
          label: "Group",
          onClick: () => addNodeTo(root.id, "group"),
        },
      ],
    });
  }
  openContextMenu(e, items);
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
    </div>

    <div
      class="tree mono"
      @contextmenu.prevent="onBlankContext"
    >
      <div
        v-for="{ node, depth } in flat"
        :key="node.id"
        class="row"
        :class="{ sel: node.id === state.selectedId }"
        :style="{ paddingLeft: 8 + depth * 14 + 'px' }"
        @click="select(node.id)"
        @contextmenu.prevent="onNodeContext($event, node.id)"
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

