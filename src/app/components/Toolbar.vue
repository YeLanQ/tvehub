<script setup lang="ts">
import { computed } from "vue";
import { getEditorStore } from "../stores/editor";

const store = getEditorStore();
const { state, engine } = store;

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
</script>

<template>
  <div class="toolbar-groups">
    <!-- 左侧：创建 -->
    <div class="group">
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

    <div class="spacer"></div>

    <!-- 右侧：历史 + 删除 -->
    <div class="group">
      <button :disabled="!state.canUndo" @click="engine.undo()">
        Undo · {{ state.undoLabel ?? "—" }}
      </button>
      <button :disabled="!state.canRedo" @click="engine.redo()">Redo</button>
      <button :disabled="!hasSelection" class="danger" @click="del">Delete</button>
    </div>
  </div>
</template>

<style scoped>
.toolbar-groups {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
}

.group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.spacer {
  flex: 1;
}
</style>