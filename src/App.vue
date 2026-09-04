<script setup lang="ts">
import Toolbar from "./app/components/Toolbar.vue";
import Viewport from "./app/components/Viewport.vue";
import DockZone from "./app/components/DockZone.vue";
import FloatingDock from "./app/components/FloatingDock.vue";
import { docks, dockDnd, beginZoneResize, DOCK_PANEL_LABEL, type DockZoneId } from "./app/docks";

/** 停靠区分隔条拖拽：调整区域尺寸 */
function onSplitDown(e: MouseEvent, zone: DockZoneId) {
  if (e.button !== 0) return;
  e.preventDefault();
  beginZoneResize(zone, e.clientX, e.clientY);
}
</script>

<template>
  <div class="editor">
    <!-- 顶部工具栏 -->
    <header class="toolbar"><Toolbar /></header>

    <!-- 主体（Unity 风格停靠布局：左侧/右侧停靠区 + 中央视口） -->
    <div class="body">
      <DockZone zone="left" />
      <div
        v-if="docks.zones.left.length"
        class="splitter split-v"
        title="拖拽调整左侧宽度"
        @mousedown="onSplitDown($event, 'left')"
      ></div>

      <main class="center"><Viewport /></main>

      <div
        v-if="docks.zones.right.length"
        class="splitter split-v"
        title="拖拽调整右侧宽度"
        @mousedown="onSplitDown($event, 'right')"
      ></div>
      <DockZone zone="right" />
    </div>

    <!-- 底部停靠区（历史） -->
    <div
      v-if="docks.zones.bottom.length"
      class="splitter split-h"
      title="拖拽调整底部高度"
      @mousedown="onSplitDown($event, 'bottom')"
    ></div>
    <DockZone zone="bottom" />

    <!-- 浮动窗口（拖出停靠区的面板） -->
    <FloatingDock v-for="f in docks.floating" :key="f.id" :win="f" />

    <!-- 拖拽幽灵（跟随鼠标的面板标签；仅实际拖拽时显示） -->
    <div
      v-if="dockDnd.active && dockDnd.moved && dockDnd.panel"
      class="dock-ghost"
      :style="{ left: dockDnd.clientX + 'px', top: dockDnd.clientY + 'px' }"
    >
      {{ DOCK_PANEL_LABEL[dockDnd.panel] }}
    </div>
    <!-- 拖拽捕获层：仅实际拖拽时渲染，盖住 iframe 等吞掉鼠标事件的区域 -->
    <div v-if="dockDnd.active && dockDnd.moved" class="dock-drag-overlay"></div>
  </div>
</template>

<style scoped>
.editor {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}
.toolbar {
  height: 44px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
}
.body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.center {
  flex: 1;
  min-width: 0;
  position: relative;
  background: var(--bg);
  overflow: hidden;
}
/* ---------- 停靠区分隔条（拖拽调整区域尺寸） ---------- */
.splitter {
  flex-shrink: 0;
  background: transparent;
  transition: background 0.12s;
  z-index: 3;
}
.splitter:hover,
.splitter:active {
  background: var(--accent);
}
.split-v {
  width: 4px;
  cursor: col-resize;
  margin: 0 -2px;
}
.split-h {
  height: 4px;
  cursor: row-resize;
  margin: -2px 0;
}
/* ---------- 拖拽幽灵（跟随鼠标的面板标签） ---------- */
.dock-ghost {
  position: fixed;
  transform: translate(-50%, -130%);
  pointer-events: none;
  z-index: 300;
  padding: 4px 14px;
  font-size: 12px;
  color: #fff;
  background: var(--accent);
  border-radius: 4px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
  white-space: nowrap;
}
/* 拖拽捕获层：透明全屏，拦截 iframe 内事件，保证拖拽流畅 */
.dock-drag-overlay {
  position: fixed;
  inset: 0;
  z-index: 250;
  cursor: grabbing;
}
</style>