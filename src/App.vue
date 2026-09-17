<script setup lang="ts">
import { onMounted, onUnmounted, type Component } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { dispatchCommand } from "./app/commands";
import { isEditingText } from "./app/commands/context";
import Toolbar from "./app/components/Toolbar.vue";
import Viewport from "./app/components/Viewport.vue";
import WebPreviewPanel from "./app/components/WebPreviewPanel.vue";
import ScriptEditorPanel from "./app/components/ScriptEditorPanel.vue";
import DockZone from "./docks/DockZone.vue";
import DockLayer from "./docks/DockLayer.vue";
import ContextMenu from "./components/ContextMenu.vue";

import HierarchyPanel from "./app/components/HierarchyPanel.vue";
import InspectorPanel from "./app/components/InspectorPanel.vue";
import ConsolePanel from "./app/components/ConsolePanel.vue";
import AssetsPanel from "./app/components/AssetsPanel.vue";
import AnimationEditorPanel from "./app/components/AnimationEditorPanel.vue";
import ConfirmDialog from "./app/components/ConfirmDialog.vue";
import PromptDialog from "./app/components/PromptDialog.vue";
import DracoCompressDialog from "./app/components/DracoCompressDialog.vue";
import FsmEditorDialog from "./app/components/logic/FsmEditorDialog.vue";
import BtEditorDialog from "./app/components/logic/BtEditorDialog.vue";
import { logicEditorState } from "./app/composables/logic-editor";
import ProjectSettingsPanel from "./app/components/ProjectSettingsPanel.vue";
import BuildPanel from "./app/components/BuildPanel.vue";
import BootMask from "./app/components/BootMask.vue";
import { docks, type DockZoneId } from "./app/docks";
import { getEditorStore } from "./app/stores/editor";
import { getProjectStore } from "./app/stores/project";
import { getBootLoadingStore } from "./app/stores/boot-loading";
import { isTauri } from "./lib/tauri-env";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  getActivePanel,
  getAssetSelection,
  installActivePanelTracker,
} from "./app/lib/active-panel";
import { mountEditor } from "./app/services/editorService";
import "./styles/global.scss";
import "./styles/components/app.scss";

const projectStore = getProjectStore();
const editorStore = getEditorStore();

// 记录最近交互面板（assets / scene），F2 重命名按上下文分派
installActivePanelTracker();

/** 退出预览（网页预览面板）返回场景编辑 */
function goScene() {
  editorStore.setViewMode("scene");
}

/** 停靠区分隔条拖拽：调整区域尺寸 */
function onSplitDown(e: MouseEvent, zone: DockZoneId) {
  if (e.button !== 0) return;
  e.preventDefault();
  docks.beginZoneResize(zone, e.clientX, e.clientY);
}

/** 停靠面板组件映射（DockZone 渲染激活页签 / DockLayer 渲染拖拽预览共用） */
const PANEL_COMP: Record<string, Component> = {
  hierarchy: HierarchyPanel,
  inspector: InspectorPanel,
  console: ConsolePanel,
  assets: AssetsPanel,
  animation: AnimationEditorPanel,
};

/** 订阅 Rust 原生菜单/快捷键事件（撤销/保存/关闭 → 前端执行） */
let unlistenNative: UnlistenFn | null = null;

/** 窗口级快捷键：F2 重命名选中节点 / W-E-R 切换变换工具 / Ctrl+Z 撤销 / Ctrl+S 保存 / Ctrl+W 关闭项目（原生菜单已移除） */
function onWindowKeyDown(e: KeyboardEvent): void {
  // 项目装载蒙版期间（standby/loading）编辑器尚未就绪：忽略全部快捷键，
  // 避免装载中途触发保存/撤销/关闭等操作
  const bootPhase = getBootLoadingStore().state.phase;
  if (bootPhase === "loading" || bootPhase === "standby") return;
  const key = e.key.toLowerCase();
  // F2：按最近交互的面板上下文重命名——资产面板内重命名选中资产；
  // 层级/视口/检查器等场景区重命名选中节点。文本焦点下不拦截（保留输入/Monaco 行为）
  if (key === "f2" && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && !isEditingText()) {
    e.preventDefault();
    if (getActivePanel() === "assets") {
      // 资产面板主选中项（文件/目录均可）；显式作为 rel 传入，避免命令回退到旧选中
      const selected = getAssetSelection();
      if (selected) void dispatchCommand("asset.renameSelected", { rel: selected });
    } else {
      void dispatchCommand("node.renameSelected");
    }
    return;
  }
  // W/E/R：切换视口变换工具（移动/旋转/缩放）。任一修饰键按下或文本焦点（输入框/Monaco）
  // 时让位；场景视图与 gizmo 拖拽守卫在 editor.gizmoMode 命令内（脚本/预览页签静默不响应）
  if (
    !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !isEditingText() &&
    (key === "w" || key === "e" || key === "r")
  ) {
    const mode = key === "w" ? "translate" : key === "e" ? "rotate" : "scale";
    void dispatchCommand("editor.gizmoMode", { mode });
    return;
  }
  if (!e.ctrlKey || e.shiftKey || e.altKey) return;
  if (key === "z") {
    e.preventDefault();
    void dispatchCommand("editor.undo");
  } else if (key === "s") {
    e.preventDefault();
    void dispatchCommand("editor.save");
  } else if (key === "w") {
    e.preventDefault();
    void dispatchCommand("editor.close");
  } else if (key === "d" && !isEditingText()) {
    // Ctrl+D：复制当前选中节点（层级面板/视口共用；文本焦点下让位）
    e.preventDefault();
    void dispatchCommand("node.duplicate");
  }
}

/** 编辑器挂载到 DOM */
onMounted(async () => {
  // 原生菜单已移除：快捷键由本窗口 keydown 直接处理；保留菜单事件通道以兼容
  try {
    unlistenNative = await listen<string>("editor-command", (e) => {
      const cmd = e.payload;
      if (cmd === "undo" || cmd === "save" || cmd === "close") {
        void dispatchCommand(`editor.${cmd}`);
      }
    });
  } catch {
    /* 浏览器开发环境没有原生菜单事件源，忽略 */
  }
  // 捕获阶段监听：避免子元素（Monaco 等）提前 stopPropagation 吞掉窗口级快捷键；
  // 文本焦点守卫在回调内自行放行，不影响输入框自身行为
  window.addEventListener("keydown", onWindowKeyDown, true);
  const container = document.querySelector<HTMLElement>(".center");
  if (container && !editorStore.state.mounted) {
    mountEditor(container);
  }
  // Tauri 下布防装载蒙版（编辑器窗口启动时隐藏，Rust 在首页交接项目后才 show）：
  // 窗口被显示时蒙版已就位，项目装载完成前不露出旧编辑器内容。
  // 布防已在 main.ts 挂载前完成（初始渲染即含蒙版），这里幂等重入兜底。
  // 浏览器直开（无窗口系统）不布防，编辑器直接可见。
  if (isTauri()) {
    getBootLoadingStore().standby();
    // 多会话：窗口由 Rust 创建时隐藏，蒙版布防后才显示，避免空白/默认 loading 闪现
    void getCurrentWindow().show().catch(() => {});
  }
});

onUnmounted(() => {
  unlistenNative?.();
  unlistenNative = null;
  window.removeEventListener("keydown", onWindowKeyDown, true);
});
</script>

<template>
  <div class="editor" @contextmenu.prevent>
    <!-- 编辑器界面（首页在独立窗口 home.html 中；本窗口常驻编辑器视图） -->
    <!-- 顶部工具栏（含窗口控制按钮，合并自独立标题栏） -->
    <header class="toolbar">
      <Toolbar />
    </header>

      <!-- 主体（停靠布局：左侧/右侧停靠区 + 中央视口） -->
      <div class="editor-body">
        <DockZone :sys="docks" :panels="PANEL_COMP" zone="left" />
        <div
          v-if="docks.layout.zones.left.length"
          class="splitter split-v"
          title="拖拽调整左侧宽度"
          @mousedown="onSplitDown($event, 'left')"
        ></div>

        <main class="center">
          <!-- 场景/布局编辑：编辑器画布（布局视图额外显示 UI 画布） -->
          <Viewport
            v-show="editorStore.state.viewMode === 'scene' || editorStore.state.viewMode === 'layout'"
          />
          <!-- 网页预览：内嵌独立网页运行当前场景（导出 + 本地静态服务 + iframe） -->
          <WebPreviewPanel
            v-if="editorStore.state.viewMode === 'preview'"
            @close="goScene"
          />
          <!-- 脚本模式：TS 脚本工作台（Monaco 编辑 + 保存即编译） -->
          <ScriptEditorPanel v-if="editorStore.state.viewMode === 'script'" />
        </main>

        <div
          v-if="docks.layout.zones.right.length"
          class="splitter split-v"
          title="拖拽调整右侧宽度"
          @mousedown="onSplitDown($event, 'right')"
        ></div>
        <DockZone :sys="docks" :panels="PANEL_COMP" zone="right" />
      </div>

      <!-- 底部停靠区（历史） -->
      <div
        v-if="docks.layout.zones.bottom.length"
        class="splitter split-h"
        title="拖拽调整底部高度"
        @mousedown="onSplitDown($event, 'bottom')"
      ></div>
      <DockZone :sys="docks" :panels="PANEL_COMP" zone="bottom" />

      <!-- 浮动窗口 + 拖拽幽灵/捕获层/落点预览（停靠系统胶水层） -->
      <DockLayer :sys="docks" :panels="PANEL_COMP" />

      <!-- 全局右键菜单 -->
      <ContextMenu />

      <!-- 全局确认弹窗 -->
      <ConfirmDialog />
      <!-- 全局输入弹窗 -->
      <PromptDialog />
      <!-- Draco 压缩参数弹窗 -->
      <DracoCompressDialog />
      <!-- 逻辑资产可视化编辑器弹窗（状态机 / 行为树；双击资产或右键「打开编辑器」） -->
      <FsmEditorDialog v-if="logicEditorState.fsmRel" :key="`fsm:${logicEditorState.fsmRel}`" :rel="logicEditorState.fsmRel" />
      <BtEditorDialog v-if="logicEditorState.btRel" :key="`bt:${logicEditorState.btRel}`" :rel="logicEditorState.btRel" />
      <!-- 项目设置面板（点击工具栏“项目信息”打开） -->
      <ProjectSettingsPanel v-if="projectStore.settingsOpen" />
      <!-- 构建导出面板（点击工具栏“构建”打开） -->
      <BuildPanel v-if="projectStore.buildOpen" />

      <!-- 项目装载蒙版（顶层：Manager 打开项目 → 资产/场景装载进度，就绪后揭幕） -->
      <BootMask />
  </div>
</template>
