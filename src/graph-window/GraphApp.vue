<script setup lang="ts">
/**
 * 场景图窗口壳（Tauri 窗口 label "graph"，与编辑器窗口同级）：
 * 打开体验与编辑器一致——Hub「打开场景图」显示窗口时装载蒙版已在，按阶段
 * 汇报「扫描资产 / 打开场景会话 / 装载场景图」后揭幕进入工作区。
 * 工作区复用编辑器的停靠系统（同款页签拖拽/浮动/分隔条调宽，布局独立持久化）：
 * 左停靠（层级）+ 中央画布/预览 + 右停靠（检查器）+ 底部停靠（资产）。
 * 场景图会话随场景自动持久化（.tve 旁路，无图资产概念）；对原型的操作是
 * 预览运行时执行的逻辑，不改动编辑器场景。
 * 快捷键：Ctrl+Z/Y 会话撤销重做、Ctrl+C/V 剪贴板、Delete 删除、F 适配视图
 * （文本输入焦点时让位给 WebView 默认行为）。
 */
import { nextTick, onMounted, onUnmounted, type Component } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ContextMenu from "../ui-kit/components/ContextMenu.vue";
import ToastHost from "../ui-kit/components/ToastHost.vue";
import WindowControls from "../ui-kit/components/WindowControls.vue";
import { isTauri } from "../lib/tauri-env";
import { isEditingText } from "../app/commands/context";
import { getGraphWindowStore } from "./graphStore";
import { getGraphBootStore } from "./boot-loading";
import { graphDocks } from "./docks";
import type { DockZoneId } from "../docks/types";
import DockZone from "../docks/DockZone.vue";
import DockLayer from "../docks/DockLayer.vue";
import ConsolePanel from "../app/components/ConsolePanel.vue";
import GraphAssets from "./components/GraphAssets.vue";
import GraphBootMask from "./components/GraphBootMask.vue";
import GraphCanvas from "./components/GraphCanvas.vue";
import GraphHierarchy from "./components/GraphHierarchy.vue";
import GraphModal from "./components/GraphModal.vue";
import GraphPreview from "./components/GraphPreview.vue";
import GraphVariablePanel from "./components/GraphVariablePanel.vue";
import GraphCustomNodePanel from "./components/GraphCustomNodePanel.vue";
import NodeInspector from "./components/NodeInspector.vue";
import "../styles/graph-window.scss";
import "../styles/components/app.scss";
import "../styles/components/toolbar.scss";
import "../styles/components/dock-zone.scss";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/controls/dist/style.css";
import "@vue-flow/minimap/dist/style.css";
import "@vue-flow/node-resizer/dist/style.css";

const store = getGraphWindowStore();
const inTauri = isTauri();

/** 工具栏空白区域 mousedown：启动窗口原生拖拽 */
function onDragDown(e: MouseEvent): void {
  if (!inTauri || e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (target.closest("button, .project-info, .tool-switch")) return;
  // 窗口句柄惰性获取：浏览器直开 graph.html 时 getCurrentWindow() 会抛错，
  // setup 里缓存会让整个组件挂不上，连降级提示都渲染不出来。
  void getCurrentWindow().startDragging();
}

/** 双击工具栏空白区域切换最大化 */
function onDragDblClick(e: MouseEvent): void {
  if (!inTauri) return;
  const target = e.target as HTMLElement;
  if (target.closest("button, .project-info, .tool-switch")) return;
  void getCurrentWindow().toggleMaximize();
}


/** 停靠区分隔条拖拽：调整区域尺寸（与编辑器同款分隔条） */
function onSplitDown(e: MouseEvent, zone: DockZoneId) {
  if (e.button !== 0) return;
  e.preventDefault();
  graphDocks.beginZoneResize(zone, e.clientX, e.clientY);
}

/** 停靠面板组件映射（面板由 store 驱动，多实例无状态冲突） */
const PANEL_COMP: Record<string, Component> = {
  hierarchy: GraphHierarchy,
  inspector: NodeInspector,
  variables: GraphVariablePanel,
  customNodes: GraphCustomNodePanel,
  assets: GraphAssets,
  // 控制台与编辑器同源（logStore）：预览引擎日志（postLog 转发）实时呈现
  console: ConsolePanel,
};

function onKeydown(e: KeyboardEvent): void {
  if (!store.ready || store.degraded) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod) {
    if (isEditingText()) return;
    const k = e.key.toLowerCase();
    if (k === "z") {
      e.preventDefault();
      if (e.shiftKey) store.canvas?.redo();
      else store.canvas?.undo();
      return;
    }
    if (k === "y") {
      e.preventDefault();
      store.canvas?.redo();
      return;
    }
    if (k === "c") {
      e.preventDefault();
      store.canvas?.copySelection();
      return;
    }
    if (k === "v") {
      e.preventDefault();
      store.canvas?.paste();
      return;
    }
    return;
  }
  if (isEditingText()) return;
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    store.canvas?.deleteSelection();
  } else if (e.key === "f") {
    store.canvas?.fitView();
  }
}

function onPageHide(): void {
  void store.flushGraph();
}

onMounted(async () => {
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("pagehide", onPageHide);
  if (isTauri()) {
    // 多会话：窗口由 Rust 动态创建时隐藏，布防已在 graph-main 挂载前完成
    // （初始渲染即含蒙版）。等含蒙版的首帧呈现后再 show（双 rAF 等合成器
    // 提交，隐藏窗口 rAF 被节流时由超时兜底；原生背景色为深色不露白）
    getGraphBootStore().standby();
    await nextTick();
    await Promise.race([
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
      new Promise<void>((resolve) => setTimeout(resolve, 250)),
    ]);
    void getCurrentWindow().show().catch(() => {});
  }
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("pagehide", onPageHide);
});
</script>

<template>
  <div class="graph-app" @contextmenu.prevent>

    <template v-if="store.degraded">
      <div class="gboot">
        <div class="gboot-title">TVE GRAPH</div>
        <div class="gboot-hint">场景图窗口需要在桌面端使用（Hub 项目卡片右键 →「打开场景图」）</div>
      </div>
    </template>
    <template v-else>
      <!-- 工作区（装载蒙版盖在其上，揭幕由 boot store 控制） -->
      <div class="gworkspace">
        <!-- 顶部工具栏（与编辑器同款结构：项目信息 + 居中视图切换 + 右侧动作） -->
        <header class="toolbar">
          <div
            class="toolbar-groups"
            @mousedown="onDragDown"
            @dblclick="onDragDblClick"
          >
            <div class="project-info" :title="store.root ?? ''">
              <span class="project-name">{{ store.projectName }}</span>
              <span class="scene-name mono">{{ store.sceneRel }}</span>
            </div>

            <div class="spacer"></div>

            <!-- 居中视图切换：图 / 预览（与编辑器 场景/预览 切换同款） -->
            <div class="tool-switch" role="tablist" title="视图模式">
              <button
                class="tool-btn"
                :class="{ active: store.centerMode === 'graph' }"
                role="tab"
                :aria-selected="store.centerMode === 'graph'"
                title="场景图编辑"
                @click="store.setCenterMode('graph')"
              >
                图
              </button>
              <button
                class="tool-btn"
                :class="{ active: store.centerMode === 'preview' }"
                role="tab"
                :aria-selected="store.centerMode === 'preview'"
                title="网页预览：图上定义的行为在此执行（与编辑器同一导出链路 + 场景图注入）"
                @click="store.setCenterMode('preview')"
              >
                预览
              </button>
            </div>

            <div class="spacer"></div>

            <button title="撤销（Ctrl+Z，会话内）" @click="store.canvas?.undo()">撤销</button>
            <button title="重做（Ctrl+Y）" @click="store.canvas?.redo()">重做</button>
            <span class="gsave-state" title="场景图随场景自动保存（graph/ 目录）">
              {{ store.graphDirty ? "自动保存中…" : store.lastSavedAt ? `已保存 ${store.lastSavedAt}` : "" }}
            </span>

            <!-- 窗口控制按钮（合并自独立标题栏） -->
            <WindowControls />
          </div>
        </header>

        <!-- 主体：左停靠（层级）+ 中央画布/预览 + 右停靠（检查器），分隔条可调宽 -->
        <div class="gbody">
          <DockZone :sys="graphDocks" :panels="PANEL_COMP" zone="left" />
          <div
            v-if="graphDocks.layout.zones.left.length"
            class="splitter split-v"
            title="拖拽调整左侧宽度"
            @mousedown="onSplitDown($event, 'left')"
          ></div>

          <main class="gcenter">
            <!-- 画布工具条（仅图模式） -->
            <div v-if="store.centerMode === 'graph'" class="gcanvas-bar">
              <button title="复制选中（Ctrl+C）" @click="store.canvas?.copySelection()">复制</button>
              <button title="粘贴（Ctrl+V）" @click="store.canvas?.paste()">粘贴</button>
              <button title="删除选中（Delete）" @click="store.canvas?.deleteSelection()">删除</button>
              <span class="gsep"></span>
              <button title="添加注释框" @click="store.canvas?.addComment()">注释框</button>
              <span class="gsep"></span>
              <button :class="{ active: store.snapToGrid }" title="网格吸附（16px）" @click="store.toggleSnap()">吸附</button>
              <button title="适配视图（F）" @click="store.canvas?.fitView()">适配</button>
              <span class="gflex"></span>
              <span class="gcanvas-hint">拖入层级实体生成原型 · 右键画布添加匹配/操作 · 行为在预览中执行</span>
            </div>
            <div class="gcenter-stage">
              <GraphCanvas v-show="store.centerMode === 'graph'" />
              <GraphPreview v-if="store.centerMode === 'preview'" />
            </div>
          </main>

          <div
            v-if="graphDocks.layout.zones.right.length"
            class="splitter split-v"
            title="拖拽调整右侧宽度"
            @mousedown="onSplitDown($event, 'right')"
          ></div>
          <DockZone :sys="graphDocks" :panels="PANEL_COMP" zone="right" />
        </div>

        <!-- 底部停靠（资产）+ 分隔条 -->
        <div
          v-if="graphDocks.layout.zones.bottom.length"
          class="splitter split-h"
          title="拖拽调整底部高度"
          @mousedown="onSplitDown($event, 'bottom')"
        ></div>
        <DockZone :sys="graphDocks" :panels="PANEL_COMP" zone="bottom" />

        <!-- 状态条（气泡提示走 ui-kit 全局宿主，不再占用状态条） -->
        <footer class="gstatus">
          <span class="gstatus-rel">{{ store.sceneEntities.length }} 个实体 · {{ store.sceneRel }}</span>
          <span class="gflex"></span>
        </footer>
      </div>

      <!-- 浮动窗口 + 拖拽幽灵/捕获层/落点预览（停靠系统胶水层） -->
      <DockLayer :sys="graphDocks" :panels="PANEL_COMP" />

      <!-- 装载蒙版（与编辑器打开体验一致） + 全局弹层 -->
      <GraphBootMask />
      <GraphModal />
      <ContextMenu />
    </template>

    <!-- 全局气泡通知（图窗口独立挂载；置于分支之外：任何窗口形态下都在） -->
    <ToastHost />
  </div>
</template>
