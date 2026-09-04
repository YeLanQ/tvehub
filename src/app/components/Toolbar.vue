<script setup lang="ts">
import { computed } from "vue";
import { getEditorStore } from "../stores/editor";
import "../../styles/components/toolbar.scss";

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
