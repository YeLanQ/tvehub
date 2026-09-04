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

    <!-- 居中：变换工具切换（场景编辑工具） -->
    <div class="tool-switch" role="tablist" aria-label="编辑器工具">
      <button
        v-for="m in modes"
        :key="m.key"
        class="tool-btn"
        :class="{ active: state.gizmoMode === m.key }"
        :disabled="!hasSelection"
        :title="m.label"
        @click="setMode(m.key)"
      >
        {{ m.label }}
      </button>
      <button class="tool-btn" :title="`切换本地/世界坐标空间（当前：${state.gizmoSpace}）`" @click="toggleSpace">
        Global: {{ state.gizmoSpace }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.toolbar-groups {
  position: relative;
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

/* 居中工具切换（Unity 工具栏风格） */
.tool-switch {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  z-index: 1;
}

.tool-btn {
  background: transparent;
  border: none;
  padding: 3px 14px;
  font-size: 12px;
  color: var(--text-dim);
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}
.tool-btn:hover:not(:disabled) {
  color: var(--text);
  background: var(--btn-hover);
}
.tool-btn.active {
  color: var(--text);
  background: var(--bg-hover);
  font-weight: 600;
}
.tool-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>