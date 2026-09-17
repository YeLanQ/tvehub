<script setup lang="ts">
import { computed } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getEditorStore, type ViewMode } from "../stores/editor";
import { getProjectStore } from "../stores/project";
import { dispatchCommand } from "../commands";
import { isTauri } from "../../lib/tauri-env";
import WindowControls from "../../ui-kit/components/WindowControls.vue";
import "../../styles/components/toolbar.scss";

const store = getEditorStore();
const projectStore = getProjectStore();
const { state } = store;
const win = getCurrentWindow();
const inTauri = isTauri();

const VIEW_TABS: { key: ViewMode; label: string; title: string }[] = [
  { key: "scene", label: "场景", title: "场景编辑" },
  {
    key: "layout",
    label: "布局",
    title: "UI 布局：显示并编辑 UI 画布（Canvas-Widget，屏幕叠加）；选中画布节点自动切换",
  },
  {
    key: "preview",
    label: "预览",
    title: "网页预览：导出当前场景为独立网页并在编辑器内嵌预览",
  },
  { key: "script", label: "脚本", title: "脚本工作台：编写 TS 脚本（保存即编译），经组件挂载到节点" },
];

const projectName = computed(() => projectStore.projectName ?? "未命名项目");
/** 编辑器是否有未保存修改（保存按钮标记点） */
const editorDirty = computed(() => store.dirty());

function setViewMode(mode: ViewMode): void {
  store.setViewMode(mode);
}

/** 工具栏空白区域 mousedown：启动窗口原生拖拽 */
function onDragDown(e: MouseEvent): void {
  if (!inTauri || e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (target.closest("button, .project-info, .tool-switch")) return;
  void win.startDragging();
}

/** 双击工具栏空白区域切换最大化 */
function onDragDblClick(e: MouseEvent): void {
  if (!inTauri) return;
  const target = e.target as HTMLElement;
  if (target.closest("button, .project-info, .tool-switch")) return;
  void win.toggleMaximize();
}
</script>

<template>
  <div
    class="toolbar-groups"

    @mousedown="onDragDown"
    @dblclick="onDragDblClick"
  >
    <!-- 项目信息：点击打开/关闭项目设置面板（物理引擎/重力/启停在其中的「物理」分类） -->
    <div
      class="project-info"
      :class="{ open: projectStore.settingsOpen }"
      :title="projectStore.currentPath ?? ''"
      @click="projectStore.settingsOpen ? projectStore.closeSettings() : projectStore.openSettings()"
    >
      <span class="project-name">{{ projectName }}</span>
      <span class="scene-name mono">{{ projectStore.sceneRel }}</span>
      <span class="project-gear" title="项目设置">⚙</span>
    </div>

    <button
      class="toolbar-build"
      title="构建导出：把场景打包为可部署产物"
      @click="projectStore.openBuild()"
    >
      构建
    </button>

    <div class="spacer"></div>

    <!-- 居中工具切换：场景 / 预览 / 脚本 -->
    <div class="tool-switch" role="tablist" title="视图模式">
      <button
        v-for="tab in VIEW_TABS"
        :key="tab.key"
        class="tool-btn"
        :class="{ active: state.viewMode === tab.key }"
        role="tab"
        :aria-selected="state.viewMode === tab.key"
        :title="tab.title"
        @click="setViewMode(tab.key)"
      >
        {{ tab.label }}
      </button>
    </div>

    <button
      :disabled="!state.canUndo"
      @click="dispatchCommand('editor.undo')"
      title="撤销上一次场景修改"
    >
      撤销
    </button>
    <button
      class="primary save-btn"
      :class="{ dirty: editorDirty }"
      :title="editorDirty ? '保存当前场景（有未保存修改）' : '保存当前场景'"
      @click="dispatchCommand('editor.save')"
    >
      保存
      <span v-if="editorDirty" class="save-dirty-dot" aria-label="有未保存修改"></span>
    </button>


    <!-- 窗口控制按钮（合并自独立标题栏） -->
    <WindowControls />
  </div>
</template>
