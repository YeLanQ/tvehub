<script setup lang="ts">
import { computed } from "vue";
import { getEditorStore } from "../stores/editor";

const store = getEditorStore();
const { state, engine } = store;

const modes = [
  { key: "translate", label: "移动 (W)" },
  { key: "rotate", label: "旋转 (E)" },
  { key: "scale", label: "缩放 (R)" },
] as const;

const hasSelection = computed(() => !!state.selectedId);

function add(kind: "box" | "sphere" | "plane" | "cylinder"): void {
  engine.addMesh(kind);
}

function addLight(kind: "point" | "directional" | "ambient"): void {
  engine.addLight(kind);
}

function addCam(): void {
  engine.addCamera();
}

function addGroup(): void {
  engine.addEmptyGroup();
}

function del(): void {
  engine.deleteSelected();
}

function setMode(mode: "translate" | "rotate" | "scale"): void {
  engine.setGizmoMode(mode);
}

function toggleSpace(): void {
  engine.setGizmoSpace(state.gizmoSpace === "local" ? "world" : "local");
}
</script>

<template>
  <div class="toolbar">
    <div class="group">
      <span class="grp-label mono muted">创建</span>
      <button @click="add('box')">Cube</button>
      <button @click="add('sphere')">Sphere</button>
      <button @click="add('cylinder')">Cylinder</button>
      <button @click="add('plane')">Plane</button>
      <button @click="addGroup">Group</button>
      <button @click="addLight('directional')">Directional Light</button>
      <button @click="addLight('point')">Point Light</button>
      <button @click="addLight('ambient')">Ambient</button>
      <button @click="addCam">Camera</button>
    </div>

    <div class="group">
      <span class="grp-label mono muted">变换工具</span>
      <button
        v-for="m in modes"
        :key="m.key"
        :class="{ 'is-active': state.gizmoMode === m.key }"
        :disabled="!hasSelection"
        @click="setMode(m.key)"
      >
        {{ m.label }}
      </button>
      <button @click="toggleSpace">Space: {{ state.gizmoSpace }}</button>
    </div>

    <div class="group">
      <span class="grp-label mono muted">历史</span>
      <button :disabled="!state.canUndo" @click="engine.undo()">Undo · {{ state.undoLabel ?? "—" }}</button>
      <button :disabled="!state.canRedo" @click="engine.redo()">Redo</button>
    </div>

    <div class="group">
      <button :disabled="!hasSelection" class="danger" @click="del">Delete</button>
    </div>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  padding: 8px 10px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}

.group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.grp-label {
  font-size: 11px;
  padding: 0 6px;
  border-right: 1px solid var(--border);
  margin-right: 2px;
}

.danger {
  border-color: #5a2830;
  color: #ff9aa6;
}
</style>