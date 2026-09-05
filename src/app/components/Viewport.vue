<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { disposeEditor, mountEditor, getEditorStore } from "../stores/editor";
import { getProjectStore } from "../stores/project";
import "../../styles/components/viewport.scss";

const host = ref<HTMLDivElement | null>(null);

const store = getEditorStore();
const projectStore = getProjectStore();
const { state, engine } = store;

function setMode(mode: "translate" | "rotate" | "scale"): void {
  engine.setGizmoMode(mode);
}

function setSpace(space: "local" | "world"): void {
  engine.setGizmoSpace(space);
}

function onDragOver(e: DragEvent): void {
  if (state.viewMode !== "scene") return;
  if (!e.dataTransfer) return;
  if (e.dataTransfer.types.includes("application/x-editor-asset")) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
}

function onDrop(e: DragEvent): void {
  if (state.viewMode !== "scene") return;
  if (!e.dataTransfer) return;
  const data = e.dataTransfer.getData("application/x-editor-asset");
  if (!data) return;
  e.preventDefault();
  try {
    const item = JSON.parse(data) as AssetItem;
    if (item.kind === "mesh") engine.addMesh(item.id as never);
    else if (item.kind === "light") engine.addLight(item.id as never);
    else if (item.kind === "camera") engine.addCamera();
    else engine.addEmptyGroup();
  } catch {
    // ignore invalid drop data
  }
}

type AssetKind = "mesh" | "light" | "camera" | "prefab";

interface AssetItem {
  id: string;
  name: string;
  kind: AssetKind;
  icon: string;
}

onMounted(() => {
  if (host.value) mountEditor(host.value, projectStore.sceneJson);
});

onBeforeUnmount(() => {
  disposeEditor();
});
</script>

<template>
  <div class="viewport">
    <div
      ref="host"
      class="viewport-canvas"
      @dragover.prevent="onDragOver"
      @drop="onDrop"
    ></div>

    <!-- 视口顶部悬浮工具栏（Unity 风格）：仅编辑场景模式下显示 -->
    <div v-if="state.viewMode === 'scene'" class="overlay top">
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

    <div v-if="state.viewMode === 'scene'" class="viewport__hint mono">左键选择 · 拖拽 Gizmo 变换 · W/E/R 切换工具</div>
    <div v-else class="viewport__hint mono">预览渲染 · 使用场景相机视角</div>
  </div>
</template>
