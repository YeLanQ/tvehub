<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { runEditorCommand, type EditorCommand } from "./app/lib/editor-commands";
import Toolbar from "./app/components/Toolbar.vue";
import Viewport from "./app/components/Viewport.vue";
import WebPreviewPanel from "./app/components/WebPreviewPanel.vue";
import ScriptEditorPanel from "./app/components/ScriptEditorPanel.vue";
import DockZone from "./app/components/DockZone.vue";
import FloatingDock from "./app/components/FloatingDock.vue";
import ContextMenu from "./components/ContextMenu.vue";
import HierarchyPanel from "./app/components/HierarchyPanel.vue";
import InspectorPanel from "./app/components/InspectorPanel.vue";
import ConsolePanel from "./app/components/ConsolePanel.vue";
import AssetsPanel from "./app/components/AssetsPanel.vue";
import ConfirmDialog from "./app/components/ConfirmDialog.vue";
import PromptDialog from "./app/components/PromptDialog.vue";
import ProjectSettingsPanel from "./app/components/ProjectSettingsPanel.vue";
import BuildPanel from "./app/components/BuildPanel.vue";
import { docks, dockDnd, beginZoneResize, DOCK_PANEL_LABEL, type DockPanelId, type DockZoneId, ALL_ZONES } from "./app/docks";
import { getEditorStore } from "./app/stores/editor";
import { getProjectStore } from "./app/stores/project";
import { mountEditor } from "./app/stores/editor";
import "./styles/global.scss";
import "./styles/components/app.scss";

const projectStore = getProjectStore();
const editorStore = getEditorStore();

/** 退出预览（网页预览面板）返回场景编辑 */
function goScene() {
  editorStore.setViewMode("scene");
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

/** 订阅 Rust 原生菜单/快捷键事件（撤销/保存/关闭 → 前端执行） */
let unlistenNative: UnlistenFn | null = null;

/** 窗口级快捷键：Ctrl+Z 撤销 / Ctrl+S 保存 / Ctrl+W 关闭项目（原生菜单已移除） */
function onWindowKeyDown(e: KeyboardEvent): void {
  if (!e.ctrlKey || e.shiftKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === "z") {
    e.preventDefault();
    void runEditorCommand("undo");
  } else if (key === "s") {
    e.preventDefault();
    void runEditorCommand("save");
  } else if (key === "w") {
    e.preventDefault();
    void runEditorCommand("close");
  }
}

/** 编辑器挂载到 DOM */
onMounted(async () => {
  // 原生菜单已移除：快捷键由本窗口 keydown 直接处理；保留菜单事件通道以兼容
  try {
    unlistenNative = await listen<string>("editor-command", (e) => {
      const cmd = e.payload as EditorCommand;
      if (cmd === "undo" || cmd === "save" || cmd === "close") runEditorCommand(cmd);
    });
  } catch {
    /* 浏览器开发环境没有原生菜单事件源，忽略 */
  }
  window.addEventListener("keydown", onWindowKeyDown);
  const container = document.querySelector<HTMLElement>(".center");
  if (container && !editorStore.state.mounted) {
    mountEditor(container);
  }
});

onUnmounted(() => {
  unlistenNative?.();
  unlistenNative = null;
  window.removeEventListener("keydown", onWindowKeyDown);
});
</script>

<template>
  <div class="editor" @contextmenu.prevent>
    <!-- 编辑器界面（首页在独立窗口 home.html 中；本窗口常驻编辑器视图） -->
    <!-- 顶部工具栏 -->
    <header class="toolbar">
      <Toolbar />
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

        <main class="center">
          <!-- 场景编辑：编辑器画布 -->
          <Viewport v-show="editorStore.state.viewMode === 'scene'" />
          <!-- 网页预览：内嵌独立网页运行当前场景（导出 + 本地静态服务 + iframe） -->
          <WebPreviewPanel
            v-if="editorStore.state.viewMode === 'preview'"
            @close="goScene"
          />
          <!-- 脚本模式：TS 脚本工作台（Monaco 编辑 + 保存即编译） -->
          <ScriptEditorPanel v-if="editorStore.state.viewMode === 'script'" />
        </main>

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

      <!-- 全局确认弹窗 -->
      <ConfirmDialog />
      <!-- 全局输入弹窗 -->
      <PromptDialog />
      <!-- 项目设置面板（点击工具栏“项目信息”打开） -->
      <ProjectSettingsPanel v-if="projectStore.settingsOpen" />
      <!-- 构建导出面板（点击工具栏“构建”打开） -->
      <BuildPanel v-if="projectStore.buildOpen" />
  </div>
</template>
