<script setup lang="ts">
import { computed } from "vue";
import { getEditorStore, type ViewMode } from "../stores/editor";
import { getProjectStore } from "../stores/project";
import { logStore } from "../stores/log";
import { saveCurrentSceneToMain } from "../lib/save-scene";
import "../../styles/components/toolbar.scss";

defineEmits<{
  goHome: [];
}>();

const store = getEditorStore();
const projectStore = getProjectStore();
const { state, engine } = store;

const VIEW_TABS: { key: ViewMode; label: string; title: string }[] = [
  { key: "scene", label: "场景", title: "场景编辑" },
  {
    key: "preview",
    label: "预览",
    title: "网页预览：导出当前场景为独立网页并在编辑器内嵌预览",
  },
  { key: "script", label: "脚本", title: "脚本（待接入）" },
];

const projectName = computed(() => projectStore.projectName ?? "未命名项目");

function setViewMode(mode: ViewMode): void {
  store.setViewMode(mode);
}

async function save(): Promise<void> {
  try {
    await saveCurrentSceneToMain();
    logStore.log("success", "场景已保存", "toolbar");
  } catch (e) {
    console.error("Failed to save scene:", e);
    logStore.log("error", `场景保存失败: ${e}`, "toolbar");
  }
}
</script>

<template>
  <div class="toolbar-groups">
    <!-- 项目信息：点击打开/关闭项目设置面板 -->
    <div
      class="project-info"
      :class="{ open: projectStore.settingsOpen }"
      :title="projectStore.currentPath ?? ''"
      @click="projectStore.settingsOpen ? projectStore.closeSettings() : projectStore.openSettings()"
    >
      <span class="project-name">{{ projectName }}</span>
      <span class="scene-name mono">assets/Main.scene</span>
      <span class="project-gear" title="项目设置">⚙</span>
    </div>

    <button class="toolbar-build" title="构建（占位）" @click="logStore.log('info', '构建功能待接入', 'toolbar')">
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

    <button :disabled="!state.canUndo" @click="engine.undo()" title="撤销上一次场景修改">撤销</button>
    <button class="primary" @click="save">保存</button>
    <button @click="$emit('goHome')" title="关闭项目返回首页">关闭</button>
  </div>
</template>
