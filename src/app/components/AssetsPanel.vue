<script setup lang="ts">
import { computed, ref } from "vue";
import { getEditorStore } from "../stores/editor";

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

function spawn(item: AssetItem): void {
  if (item.kind === "mesh") engine.addMesh(item.id as never);
  else if (item.kind === "light") engine.addLight(item.id as never);
  else if (item.kind === "camera") engine.addCamera();
  else engine.addEmptyGroup();
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
      <div class="am-content view-grid">
        <div
          v-for="item in currentGroup.items"
          :key="item.id"
          class="am-item grid"
          :title="`创建 ${item.name}`"
          @click="spawn(item)"
        >
          <span class="am-icon">{{ item.icon }}</span>
          <span class="am-name">{{ item.name }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.assets {
  flex: 1;
  min-height: 0;
}

.am-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.am-tree {
  width: 110px;
  flex-shrink: 0;
  overflow-y: auto;
  border-right: 1px solid var(--border);
  padding: 4px 0;
}

.am-tree-item {
  padding: 5px 10px;
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
  white-space: nowrap;
}

.am-tree-item:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.am-tree-item.active {
  background: var(--bg-active);
  color: var(--text);
  box-shadow: inset 2px 0 0 var(--accent);
}

.am-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 6px;
}

.am-content.view-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
  gap:6px;
  align-content: start;
}

.am-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 4px;
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
  background: var(--bg-panel-2);
}

.am-item:hover {
  background: var(--bg-hover);
}

.am-icon {
  font-size: 18px;
  line-height: 1;
  color: var(--text);
}

.am-name {
  font-size: 11px;
  color: var(--text-dim);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
</style>