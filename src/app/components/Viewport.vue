<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { disposeEditor, mountEditor, getEditorStore } from "../stores/editor";

const host = ref<HTMLDivElement | null>(null);

const store = getEditorStore();
const { state, engine } = store;

function setMode(mode: "translate" | "rotate" | "scale"): void {
  engine.setGizmoMode(mode);
}

function setSpace(space: "local" | "world"): void {
  engine.setGizmoSpace(space);
}

onMounted(() => {
  if (host.value) mountEditor(host.value);
});

onBeforeUnmount(() => {
  disposeEditor();
});
</script>

<template>
  <div class="viewport">
    <div ref="host" class="viewport-canvas"></div>

    <!-- 视口顶部悬浮工具栏（Unity 风格）：变换工具 + gizmo 坐标系 -->
    <div class="overlay top">
      <div class="tool-group" title="变换工具">
        <button
          class="mini"
          :class="{ active: state.gizmoMode === 'translate' }"
          title="移动工具 (W)"
          @click="setMode('translate')"
        >
          移动
        </button>
        <button
          class="mini"
          :class="{ active: state.gizmoMode === 'rotate' }"
          title="旋转工具 (E)"
          @click="setMode('rotate')"
        >
          旋转
        </button>
        <button
          class="mini"
          :class="{ active: state.gizmoMode === 'scale' }"
          title="缩放工具 (R)"
          @click="setMode('scale')"
        >
          缩放
        </button>
      </div>

      <div class="tool-group" title="gizmo 坐标系">
        <button
          class="mini"
          :class="{ active: state.gizmoSpace === 'local' }"
          title="使用对象自身轴（本地坐标）"
          @click="setSpace('local')"
        >
          本地
        </button>
        <button
          class="mini"
          :class="{ active: state.gizmoSpace === 'world' }"
          title="使用场景固定轴（世界坐标）"
          @click="setSpace('world')"
        >
          世界
        </button>
      </div>
    </div>

    <div class="viewport__hint mono">左键选择 · 拖拽 Gizmo 变换 · W/E/R 切换工具</div>
  </div>
</template>

<style scoped>
.viewport {
  position: relative;
  width: 100%;
  height: 100%;
  background: var(--bg);
  overflow: hidden;
}

.viewport-canvas {
  position: absolute;
  inset: 0;
}

.overlay {
  position: absolute;
  pointer-events: none;
}

.overlay.top {
  top: 8px;
  left: 8px;
  right: 8px;
  display: flex;
  gap: 8px;
}

.overlay .mini {
  pointer-events: auto;
}

.tool-group {
  display: flex;
  gap: 4px;
  pointer-events: auto;
  background: rgba(0, 0, 0, 0.45);
  border-radius: 4px;
  padding: 2px;
}

.mini {
  padding: 2px 10px;
  font-size: 11px;
  background: transparent;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  border-radius: 3px;
}
.mini:hover {
  color: var(--text);
  background: var(--btn-hover);
}
.mini.active {
  background: var(--bg-hover);
  color: var(--accent);
  font-weight: 600;
}

.viewport__hint {
  position: absolute;
  left: 10px;
  bottom: 8px;
  pointer-events: none;
  opacity: 0.6;
  font-size: 11px;
  color: var(--text-dim);
}
</style>