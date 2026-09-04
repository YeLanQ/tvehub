<script setup lang="ts">
import { computed, ref } from "vue";
import { getEditorStore } from "../stores/editor";
import {
  openContextMenu,
  menuSeparator,
  type CtxMenuItem,
} from "../../lib/editor/context-menu";
import "../../styles/components/assets-panel.scss";

const { engine } = getEditorStore();

type AssetKind = "mesh" | "light" | "camera" | "prefab";

interface AssetItem {
  id: string;
  name: string;
  kind: AssetKind;
  icon: string;
}

interface AssetGroup {
  id: string;
  label: string;
  kind: AssetKind;
  items: AssetItem[];
}

const groups: AssetGroup[] = [
  {
    id: "mesh",
    label: "网格",
    kind: "mesh",
    items: [
      { id: "box", name: "Cube", kind: "mesh", icon: "▣" },
      { id: "sphere", name: "Sphere", kind: "mesh", icon: "◉" },
      { id: "cylinder", name: "Cylinder", kind: "mesh", icon: "⬡" },
      { id: "plane", name: "Plane", kind: "mesh", icon: "▭" },
    ],
  },
  {
    id: "light",
    label: "灯光",
    kind: "light",
    items: [
      { id: "point", name: "Point Light", kind: "light", icon: "✸" },
      { id: "directional", name: "Directional Light", kind: "light", icon: "☀" },
      { id: "ambient", name: "Ambient", kind: "light", icon: "◌" },
    ],
  },
  {
    id: "camera",
    label: "相机",
    kind: "camera",
    items: [{ id: "camera", name: "Camera", kind: "camera", icon: "◉" }],
  },
  {
    id: "prefab",
    label: "预置",
    kind: "prefab",
    items: [{ id: "group", name: "Group", kind: "prefab", icon: "⊞" }],
  },
];

const currentGroupId = ref<string>("mesh");

const currentGroup = computed(
  () => groups.find((g) => g.id === currentGroupId.value) ?? groups[0],
);

function spawn(item: AssetItem, parentId?: string): void {
  if (item.kind === "mesh") engine.addMesh(item.id as never, parentId);
  else if (item.kind === "light") engine.addLight(item.id as never, parentId);
  else if (item.kind === "camera") engine.addCamera(parentId);
  else engine.addEmptyGroup(parentId);
}

function onItemContext(e: MouseEvent, item: AssetItem): void {
  e.preventDefault();
  e.stopPropagation();
  const items: CtxMenuItem[] = [];
  items.push({
    label: `创建 ${item.name}`,
    onClick: () => spawn(item),
  });
  items.push(menuSeparator());
  items.push({
    label: "添加到选中节点",
    onClick: () => spawn(item, undefined),
  });
  openContextMenu(e, items);
}

function onDragStart(e: DragEvent, item: AssetItem): void {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData("application/x-editor-asset", JSON.stringify(item));
  e.dataTransfer.effectAllowed = "copy";
}

function onContentContext(e: MouseEvent): void {
  e.preventDefault();
  e.stopPropagation();
  const items: CtxMenuItem[] = [];
  items.push({
    label: "新建",
    children: [
      {
        label: "网格",
        header: true,
      },
      {
        label: "Cube",
        onClick: () => engine.addMesh("box"),
      },
      {
        label: "Sphere",
        onClick: () => engine.addMesh("sphere"),
      },
      {
        label: "Cylinder",
        onClick: () => engine.addMesh("cylinder"),
      },
      {
        label: "Plane",
        onClick: () => engine.addMesh("plane"),
      },
      menuSeparator(),
      {
        label: "灯光",
        header: true,
      },
      {
        label: "Point Light",
        onClick: () => engine.addLight("point"),
      },
      {
        label: "Directional Light",
        onClick: () => engine.addLight("directional"),
      },
      {
        label: "Ambient",
        onClick: () => engine.addLight("ambient"),
      },
      menuSeparator(),
      {
        label: "Camera",
        onClick: () => engine.addCamera(),
      },
      {
        label: "Group",
        onClick: () => engine.addEmptyGroup(),
      },
    ],
  });
  openContextMenu(e, items);
}
</script>

<template>
  <div class="panel assets">
    <div class="am-body">
      <div class="am-tree">
        <div
          v-for="g in groups"
          :key="g.id"
          class="am-tree-item"
          :class="{ active: g.id === currentGroupId }"
          @click="currentGroupId = g.id"
        >
          {{ g.label }}
        </div>
      </div>
      <div
        class="am-content view-grid"
        @contextmenu.prevent="onContentContext"
      >
        <div
          v-for="item in currentGroup.items"
          :key="item.id"
          class="am-item grid"
          :title="`创建 ${item.name} · 拖拽到视口`"
          draggable
          @click="spawn(item)"
          @dragstart="onDragStart($event, item)"
          @contextmenu.prevent="onItemContext($event, item)"
        >
          <span class="am-icon">{{ item.icon }}</span>
          <span class="am-name">{{ item.name }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

