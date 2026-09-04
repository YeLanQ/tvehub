<script setup lang="ts">
import {
  dockDnd,
  beginTabDrag,
  closeFloating,
  DOCK_PANEL_LABEL,
  type FloatingDock,
} from "../docks";
import HierarchyPanel from "./HierarchyPanel.vue";
import InspectorPanel from "./InspectorPanel.vue";
import HistoryPanel from "./HistoryPanel.vue";

const props = defineProps<{ win: FloatingDock }>();

function onHeadDown(e: MouseEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  beginTabDrag(props.win.panel, "floating", e.clientX, e.clientY);
}

function style() {
  return {
    left: `${props.win.x}px`,
    top: `${props.win.y}px`,
    width: `${props.win.w}px`,
    height: `${props.win.h}px`,
    zIndex: dockDnd.active && dockDnd.panel === props.win.panel ? 100 : 60,
  };
}
</script>

<template>
  <div class="floating-dock" :style="style()">
    <div class="floating-head" @mousedown="onHeadDown">
      <span class="floating-title">{{ DOCK_PANEL_LABEL[win.panel] }}</span>
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
      <HierarchyPanel v-show="win.panel === 'hierarchy'" />
      <InspectorPanel v-show="win.panel === 'inspector'" />
      <HistoryPanel v-show="win.panel === 'history'" />
    </div>
  </div>
</template>

<style scoped>
.floating-dock {
  position: fixed;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}
.floating-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 4px 12px;
  background: var(--bg-panel-2);
  border-bottom: 1px solid var(--border);
  cursor: grab;
  user-select: none;
  flex-shrink: 0;
}
.floating-head:active {
  cursor: grabbing;
}
.floating-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}
.floating-hint {
  font-size: 11px;
  color: var(--text-dim);
}
.floating-close {
  margin-left: auto;
  background: transparent;
  border: none;
  color: var(--text-dim);
  font-size: 12px;
  padding: 0 4px;
  cursor: pointer;
}
.floating-close:hover {
  background: var(--btn-hover);
  border: none;
  color: var(--err);
}
.floating-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.floating-body :deep(.hierarchy),
.floating-body :deep(.inspector),
.floating-body :deep(.history) {
  flex: 1;
  min-height: 0;

}
</style>