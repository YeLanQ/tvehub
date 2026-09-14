<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { getEditorStore } from "../stores/editor";
import { disposeEditor, mountEditor } from "../services/editorService";
import { dispatchCommand } from "../commands";
import DebugStatsPanel from "./DebugStatsPanel.vue";
import "../../styles/components/viewport.scss";

const host = ref<HTMLDivElement | null>(null);
const showDebugStats = ref(false);

const store = getEditorStore();
const { state, engine } = store;

/** 笔刷面板本地状态（与引擎笔刷参数双向同步；挂载时初始化为引擎当前值） */
const tool = ref<"paint" | "sculpt">(engine.getTerrainPaintBrush().tool);
const brushLayer = ref(engine.getTerrainPaintBrush().layer);
const brushSize = ref(engine.getTerrainPaintBrush().radius);
const brushStrength = ref(engine.getTerrainPaintBrush().strength);
const brushErase = ref(engine.getTerrainPaintBrush().erase);
const sculptMode = ref(engine.getTerrainPaintBrush().sculptMode);

watch([tool, brushLayer, brushSize, brushStrength, brushErase, sculptMode], () => {
  engine.setTerrainPaintBrush({
    tool: tool.value,
    layer: brushLayer.value,
    radius: brushSize.value,
    strength: brushStrength.value,
    erase: brushErase.value,
    sculptMode: sculptMode.value,
  });
});

function numToHex(v: number): string {
  return "#" + (v & 0xffffff).toString(16).padStart(6, "0");
}

function togglePaint(): void {
  void dispatchCommand("editor.terrainPaint");
}

function setMode(mode: "translate" | "rotate" | "scale"): void {
  engine.setGizmoMode(mode);
}

function setSpace(space: "local" | "world"): void {
  engine.setGizmoSpace(space);
}

function isEditMode(): boolean {
  return state.viewMode === "scene" || state.viewMode === "layout";
}

function onDragOver(e: DragEvent): void {
  if (!isEditMode()) return;
  if (!e.dataTransfer) return;
  if (e.dataTransfer.types.includes("application/x-editor-asset")) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
}

function onDrop(e: DragEvent): void {
  if (!isEditMode()) return;
  if (!e.dataTransfer) return;
  const data = e.dataTransfer.getData("application/x-editor-asset");
  if (!data) return;
  e.preventDefault();
  try {
    const item = JSON.parse(data) as AssetItem;
    const args: Record<string, unknown> = {};
    if (item.kind === "mesh") {
      args.kind = "mesh";
      args.subtype = item.id;
    } else if (item.kind === "light") {
      args.kind = "light";
      args.subtype = item.id;
    } else if (item.kind === "camera") {
      args.kind = "camera";
    } else {
      args.kind = "group";
    }
    void dispatchCommand("node.add", args);
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
  if (host.value) mountEditor(host.value);
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

    <!-- 动画聚焦编辑的压暗在材质层完成（anim-edit-mode），视口无 DOM 蒙版 -->

    <!-- 视口顶部悬浮工具栏：场景/布局编辑模式下显示 -->
    <div v-if="isEditMode()" class="overlay top">
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

      <div class="tool-group" title="地形绘制（选中地形并生成 Splatmap 后可用）">
        <button
          class="mini"
          :class="{ active: state.terrainPaintActive }"
          title="地形表面绘制：用笔刷把材质层画到 Splatmap 上（左键涂抹，右键平移照常）"
          @click="togglePaint"
        >
          绘制
        </button>
      </div>

      <div class="spacer"></div>

      <div class="tool-group" title="调试">
        <button
          class="mini"
          :class="{ active: showDebugStats }"
          title="显示/隐藏渲染统计信息"
          @click="showDebugStats = !showDebugStats"
        >
          调试
        </button>
      </div>
    </div>

    <DebugStatsPanel v-if="showDebugStats" />

    <!-- 地形绘制浮动面板（激活时底部居中）：工具 / 层与模式 / 大小 / 强度 -->
    <div v-if="state.terrainPaintActive" class="paint-panel">
      <span class="pp-title">地形</span>
      <div class="pp-tabs">
        <button class="mini" :class="{ active: tool === 'sculpt' }" title="雕刻地形高度（抬升/压低/压平/平滑）" @click="tool = 'sculpt'">雕刻</button>
        <button class="mini" :class="{ active: tool === 'paint' }" title="绘制材质层到 Splatmap" @click="tool = 'paint'">绘制层</button>
      </div>

      <template v-if="tool === 'sculpt'">
        <div class="pp-modes">
          <button class="mini" :class="{ active: sculptMode === 'raise' }" @click="sculptMode = 'raise'">抬升</button>
          <button class="mini" :class="{ active: sculptMode === 'lower' }" @click="sculptMode = 'lower'">压低</button>
          <button class="mini" :class="{ active: sculptMode === 'flatten' }" @click="sculptMode = 'flatten'">压平</button>
          <button class="mini" :class="{ active: sculptMode === 'smooth' }" @click="sculptMode = 'smooth'">平滑</button>
        </div>
      </template>
      <template v-else>
        <div class="pp-layers">
          <button
            v-for="(c, i) in state.terrainPaintLayers.slice(0, 4)"
            :key="i"
            class="pp-layer"
            :class="{ active: brushLayer === i }"
            :style="{ '--layer-color': numToHex(c) }"
            :title="`材质层 ${i + 1}`"
            @click="brushLayer = i"
          >
            {{ i + 1 }}
          </button>
        </div>
        <button class="mini" :class="{ active: brushErase }" title="擦除该层权重（转移回其余层）" @click="brushErase = !brushErase">
          {{ brushErase ? "擦除中" : "擦除" }}
        </button>
      </template>

      <label class="pp-slider">
        大小
        <input type="range" min="0.5" max="40" step="0.5" v-model.number="brushSize" />
        <span class="mono">{{ brushSize.toFixed(1) }}m</span>
      </label>
      <label class="pp-slider">
        强度
        <input type="range" min="0.05" max="1" step="0.05" v-model.number="brushStrength" />
        <span class="mono">{{ Math.round(brushStrength * 100) }}%</span>
      </label>
      <button class="mini" title="退出绘制模式" @click="togglePaint">退出</button>
    </div>

    <div v-if="isEditMode()" class="viewport__hint mono">
      {{
        store.state.viewMode === "layout"
          ? "左键选择 · 拖拽 Gizmo 变换 · W/E/R 切换工具 · 滚轮缩放 · 右键拖拽平移"
          : "左键选择 · 拖拽 Gizmo 变换 · W/E/R 切换工具"
      }}
    </div>
    <div v-else class="viewport__hint mono">预览渲染 · 使用场景相机视角</div>
  </div>
</template>

