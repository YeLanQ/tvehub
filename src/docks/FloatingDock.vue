<script setup lang="ts">
/**
 * 通用浮动面板（编辑器/图窗口共用）：
 * 标题栏拖拽 = 移动/停靠，✕ = 关闭并返回原停靠区；
 * 面板内容由 panels 映射（面板名 → 组件）渲染。
 */
import { type Component } from "vue";
import type { DockSystem, FloatingDock } from "./types";
import "../styles/components/floating-dock.scss";

const props = defineProps<{
  sys: DockSystem<string>;
  win: FloatingDock<string>;
  panels: Record<string, Component>;
}>();

function onHeadDown(e: MouseEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  props.sys.beginTabDrag(props.win.panel, "floating", e.clientX, e.clientY);
}

function style() {
  return {
    left: `${props.win.x}px`,
    top: `${props.win.y}px`,
    height: `${props.win.h}px`,
    zIndex: 320,
  };
}
</script>

<template>
  <div class="floating-dock" :style="style()">
    <div class="floating-head" @mousedown="onHeadDown">
      <span class="floating-title">{{ sys.labels[win.panel] }}</span>
      <span class="floating-hint" title="拖拽标题栏可停靠/移动">⠿</span>
      <button
        class="floating-close"
        title="关闭并返回停靠区"
        @mousedown.stop
        @click="sys.closeFloating(win.panel)"
      >
        ✕
      </button>
    </div>
    <div class="floating-body">
      <component :is="panels[win.panel]" v-if="panels[win.panel]" />
    </div>
  </div>
</template>
