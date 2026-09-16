<script setup lang="ts">
/**
 * 脚本图窗口浮动面板（编辑器 FloatingDock 的图窗口版，槽位化）：
 * 标题栏拖拽 = 移动/停靠，✕ = 关闭并返回原停靠区。
 */
import {
  closeFloating,
  GRAPH_DOCK_PANEL_LABEL,
  type GraphFloatingDock as GraphFloatingDockWin,
} from "../docks";
import { beginTabDrag } from "../graph-dock-dnd";
import "../../styles/components/floating-dock.scss";

const props = defineProps<{ win: GraphFloatingDockWin }>();

function onHeadDown(e: MouseEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  beginTabDrag(props.win.panel, "floating", e.clientX, e.clientY);
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
      <span class="floating-title">{{ GRAPH_DOCK_PANEL_LABEL[win.panel] }}</span>
      <span class="floating-hint" title="拖拽标题栏可停靠/移动">⠿</span>
      <button
        class="floating-close"
        title="关闭并返回停靠区"
        @mousedown.stop
        @click="closeFloating(win.panel)"
      >
        ✕
      </button>
    </div>
    <div class="floating-body">
      <slot :name="win.panel"></slot>
    </div>
  </div>
</template>
