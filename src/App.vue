<script setup lang="ts">
import { computed, onMounted } from "vue";
import Toolbar from "./app/components/Toolbar.vue";
import Viewport from "./app/components/Viewport.vue";
import DockZone from "./app/components/DockZone.vue";
import FloatingDock from "./app/components/FloatingDock.vue";
import ContextMenu from "./components/ContextMenu.vue";
import HierarchyPanel from "./app/components/HierarchyPanel.vue";
import InspectorPanel from "./app/components/InspectorPanel.vue";
import ConsolePanel from "./app/components/ConsolePanel.vue";
import AssetsPanel from "./app/components/AssetsPanel.vue";
import HomeView from "./app/components/HomeView.vue";
import { docks, dockDnd, beginZoneResize, DOCK_PANEL_LABEL, type DockPanelId, type DockZoneId, ALL_ZONES } from "./app/docks";
import { getEditorStore } from "./app/stores/editor";
import { getProjectStore } from "./app/stores/project";
import { mountEditor } from "./app/stores/editor";
import "./styles/global.scss";
import "./styles/components/app.scss";

const projectStore = getProjectStore();
const editorStore = getEditorStore();

const isHome = computed(() => projectStore.view === "home");

function goHome() {
  projectStore.setView("home");
}

/** 停靠区分隔条拖拽：调整区域尺寸 */
function onSplitDown(e: MouseEvent, zone: DockZoneId) {
  if (e.button !== 0) return;
  e.preventDefault();
  beginZoneResize(zone, e.clientX, e.clientY);
}

/** 拖拽预览用的面板组件映射 */
const PANEL_COMP: Record<DockPanelId, any> = {
  hierarchy: HierarchyPanel,
  inspector: InspectorPanel,
  console: ConsolePanel,
  assets: AssetsPanel,
};
function panelComponent(p: DockPanelId) {
  return PANEL_COMP[p];
}

/** 拖拽预览位置：落点停靠区的矩形 */
const previewStyle = computed(() => {
  const t = dockDnd.target;
  if (!t || t.kind !== "zone") return null;
  for (const z of ALL_ZONES) {
    const el = document.querySelector<HTMLElement>(`.dock-zone.${z}`);
    if (el && z === t.zone) {
      const r = el.getBoundingClientRect();
      return {
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      };
    }
  }
  return null;
});

/** 编辑器挂载到 DOM */
onMounted(() => {
  const container = document.querySelector<HTMLElement>(".center");
  if (container && !editorStore.state.mounted) {
    mountEditor(container);
  }
});
</script>

<template>
  <div class="editor" @contextmenu.prevent>
    <!-- 项目管理器首页 -->
    <HomeView v-if="isHome" />

    <!-- 编辑器界面 -->
    <template v-else>
      <!-- 顶部工具栏 -->
      <header class="toolbar">
        <Toolbar @go-home="goHome" />
      </header>

      <!-- 主体（Unity 风格停靠布局：左侧/右侧停靠区 + 中央视口） -->
      <div class="editor-body">
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

      <!-- 拖拽预览：落点位置实时显示面板内容 -->
      <div
        v-if="dockDnd.active && dockDnd.moved && dockDnd.panel && dockDnd.target && previewStyle"
        class="dock-preview"
        :style="previewStyle"
      >
        <component :is="panelComponent(dockDnd.panel)" />
      </div>

      <!-- 全局右键菜单 -->
      <ContextMenu />
    </template>
  </div>
</template>
