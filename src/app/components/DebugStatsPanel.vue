<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { getEditorStore } from "../stores/editor";
import type { RenderStats } from "../../framework/engine/modules/RendererManager";
import "../../styles/components/debug-stats-panel.scss";

const { engine } = getEditorStore();
const stats = ref<RenderStats>({
  fps: 0,
  drawCalls: 0,
  triangles: 0,
  lines: 0,
  points: 0,
  geometries: 0,
  textures: 0,
  programs: 0,
  meshes: 0,
  vertices: 0,
});

let timer = 0;

onMounted(() => {
  timer = window.setInterval(() => {
    stats.value = engine.renderer.getStats();
  }, 200);
});

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}
</script>

<template>
  <div class="debug-stats-panel mono">
    <div class="stat-row">
      <span class="stat-label">FPS</span>
      <span class="stat-value" :class="{ low: stats.fps < 30, mid: stats.fps >= 30 && stats.fps < 50 }">
        {{ stats.fps }}
      </span>
    </div>
    <div class="stat-row">
      <span class="stat-label">DrawCalls</span>
      <span class="stat-value">{{ stats.drawCalls }}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">网格</span>
      <span class="stat-value">{{ stats.meshes }}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">顶点</span>
      <span class="stat-value">{{ fmt(stats.vertices) }}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">三角面</span>
      <span class="stat-value">{{ fmt(stats.triangles) }}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">几何体</span>
      <span class="stat-value">{{ stats.geometries }}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">纹理</span>
      <span class="stat-value">{{ stats.textures }}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">着色器</span>
      <span class="stat-value">{{ stats.programs }}</span>
    </div>
  </div>
</template>