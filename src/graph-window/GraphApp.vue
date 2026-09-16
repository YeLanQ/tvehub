<script setup lang="ts">
/**
 * 脚本图窗口壳（Tauri 窗口 label "graph"，与编辑器窗口同级）：
 * 打开体验与编辑器一致——Hub「打开脚本图」显示窗口时装载蒙版已在，按阶段
 * 汇报「扫描资产 / 打开场景会话 / 装载脚本图」后揭幕进入工作区。
 * 工作区复用编辑器的停靠系统（同款页签拖拽/浮动/分隔条调宽，布局独立持久化）：
 * 左停靠（层级）+ 中央画布/预览 + 右停靠（检查器）+ 底部停靠（资产）。
 * 脚本图会话随场景自动持久化（.tve 旁路，无图资产概念）；对原型的操作是
 * 预览运行时执行的逻辑，不改动编辑器场景。
 * 快捷键：Ctrl+Z/Y 会话撤销重做、Ctrl+C/V 剪贴板、Delete 删除、F 适配视图
 * （文本输入焦点时让位给 WebView 默认行为）。
 */
import { computed, markRaw, onMounted, onUnmounted } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ContextMenu from "../ui-kit/components/ContextMenu.vue";
import { isEditingText } from "../app/commands/context";
import { getGraphWindowStore } from "./graphStore";
import {
  graphDocks,
  GRAPH_ALL_ZONES,
  GRAPH_DOCK_PANEL_LABEL,
  type GraphDockPanelId,
  type GraphDockZoneId,
} from "./docks";
import { beginZoneResize } from "./graph-dock-resize";
import { graphDockDnd } from "./graph-dock-dnd";
import GraphAssets from "./components/GraphAssets.vue";
import GraphBootMask from "./components/GraphBootMask.vue";
import GraphCanvas from "./components/GraphCanvas.vue";
import GraphDockZone from "./components/GraphDockZone.vue";
import GraphFloatingDock from "./components/GraphFloatingDock.vue";
import GraphHierarchy from "./components/GraphHierarchy.vue";
import GraphModal from "./components/GraphModal.vue";
import GraphPreview from "./components/GraphPreview.vue";
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

/** 关闭脚本图窗口（隐藏；会话图已自动保存） */
async function closeWindow(): Promise<void> {
  await store.flushGraph();
  try {
    await getCurrentWindow().hide();
  } catch {
    /* 非 Tauri 环境忽略 */
  }
}

/** 停靠区分隔条拖拽：调整区域尺寸（与编辑器同款分隔条） */
function onSplitDown(e: MouseEvent, zone: GraphDockZoneId) {
  if (e.button !== 0) return;
  e.preventDefault();
  beginZoneResize(zone, e.clientX, e.clientY);
}

/** 拖拽预览用的面板组件映射（面板由 store 驱动，多实例无状态冲突） */
const PANEL_COMP: Record<GraphDockPanelId, unknown> = {
  hierarchy: markRaw(GraphHierarchy),
  inspector: markRaw(NodeInspector),
  assets: markRaw(GraphAssets),
};

/** 拖拽预览框：落在目标停靠区的矩形（与编辑器 App 同实现） */
const previewStyle = computed(() => {
  const t = graphDockDnd.target;
  if (!t || t.kind !== "zone") return null;
  for (const z of GRAPH_ALL_ZONES) {
    const el = document.querySelector<HTMLElement>(`.graph-app .dock-zone.${z}`);
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

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("pagehide", onPageHide);
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
        <div class="gboot-hint">脚本图窗口需要在桌面端使用（Hub 项目卡片右键 →「打开脚本图」）</div>
      </div>
    </template>
    <template v-else>
      <!-- 工作区（装载蒙版盖在其上，揭幕由 boot store 控制） -->
      <div class="gworkspace">
        <!-- 顶部工具栏（与编辑器同款结构：项目信息 + 居中视图切换 + 右侧动作） -->
        <header class="toolbar">
          <div class="toolbar-groups">
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
                title="脚本图编辑"
                @click="store.setCenterMode('graph')"
              >
                图
              </button>
              <button
                class="tool-btn"
                :class="{ active: store.centerMode === 'preview' }"
                role="tab"
                :aria-selected="store.centerMode === 'preview'"
                title="网页预览：图上定义的行为在此执行（与编辑器同一导出链路 + 脚本图注入）"
                @click="store.setCenterMode('preview')"
              >
                预览
              </button>
            </div>

            <div class="spacer"></div>

            <button title="撤销（Ctrl+Z，会话内）" @click="store.canvas?.undo()">撤销</button>
            <button title="重做（Ctrl+Y）" @click="store.canvas?.redo()">重做</button>
            <span class="gsave-state" title="脚本图随场景自动保存（.tve 旁路，不产生图资产）">
              {{ store.graphDirty ? "自动保存中…" : store.lastSavedAt ? `已保存 ${store.lastSavedAt}` : "" }}
            </span>
            <button title="关闭脚本图窗口" @click="closeWindow()">关闭</button>
          </div>
        </header>

        <!-- 主体：左停靠（层级）+ 中央画布/预览 + 右停靠（检查器），分隔条可调宽 -->
        <div class="gbody">
          <GraphDockZone zone="left">
            <template #hierarchy><GraphHierarchy /></template>
          </GraphDockZone>
          <div
            v-if="graphDocks.zones.left.length"
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
            v-if="graphDocks.zones.right.length"
            class="splitter split-v"
            title="拖拽调整右侧宽度"
            @mousedown="onSplitDown($event, 'right')"
          ></div>
          <GraphDockZone zone="right">
            <template #inspector><NodeInspector /></template>
          </GraphDockZone>
        </div>

        <!-- 底部停靠（资产）+ 分隔条 -->
        <div
          v-if="graphDocks.zones.bottom.length"
          class="splitter split-h"
          title="拖拽调整底部高度"
          @mousedown="onSplitDown($event, 'bottom')"
        ></div>
        <GraphDockZone zone="bottom">
          <template #assets><GraphAssets /></template>
        </GraphDockZone>

        <!-- 状态条 -->
        <footer class="gstatus">
          <span class="gstatus-rel">{{ store.sceneEntities.length }} 个实体 · {{ store.sceneRel }}</span>
          <span class="gflex"></span>
          <span class="gnotice">{{ store.notice }}</span>
        </footer>
      </div>

      <!-- 浮动面板（拖出停靠区的面板） -->
      <GraphFloatingDock v-for="f in graphDocks.floating" :key="f.id" :win="f">
        <template #hierarchy><GraphHierarchy /></template>
        <template #inspector><NodeInspector /></template>
        <template #assets><GraphAssets /></template>
      </GraphFloatingDock>

      <!-- 拖拽幽灵（跟随鼠标的面板标签；仅实际拖拽时显示） -->
      <div
        v-if="graphDockDnd.active && graphDockDnd.moved && graphDockDnd.panel"
        class="dock-ghost"
        :style="{ left: graphDockDnd.clientX + 'px', top: graphDockDnd.clientY + 'px' }"
      >
        {{ GRAPH_DOCK_PANEL_LABEL[graphDockDnd.panel] }}
      </div>
      <!-- 拖拽捕获层：仅实际拖拽时渲染，盖住 iframe 等吞掉鼠标事件的区域 -->
      <div v-if="graphDockDnd.active && graphDockDnd.moved" class="dock-drag-overlay"></div>

      <!-- 拖拽预览：落点位置实时显示面板内容 -->
      <div
        v-if="graphDockDnd.active && graphDockDnd.moved && graphDockDnd.panel && graphDockDnd.target && previewStyle"
        class="dock-preview"
        :style="previewStyle"
      >
        <component :is="PANEL_COMP[graphDockDnd.panel]" />
      </div>

      <!-- 装载蒙版（与编辑器打开体验一致） + 全局弹层 -->
      <GraphBootMask />
      <GraphModal />
      <ContextMenu />
    </template>
  </div>
</template>
