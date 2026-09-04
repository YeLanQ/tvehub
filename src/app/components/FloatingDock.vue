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
import ConsolePanel from "./ConsolePanel.vue";
import AssetsPanel from "./AssetsPanel.vue";
import "../../styles/components/floating-dock.scss";

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
      height: `${props.win.h}px`,
      zIndex: dockDnd.active && dockDnd.panel === props.win.panel ? 320 : 320,
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
      <HierarchyPanel v-if="win.panel === 'hierarchy'" />
      <InspectorPanel v-if="win.panel === 'inspector'" />
      <ConsolePanel v-if="win.panel === 'console'" />
      <AssetsPanel v-if="win.panel === 'assets'" />
    </div>
  </div>
</template>
