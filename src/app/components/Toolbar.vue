<script setup lang="ts">
import { computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getEditorStore, type ViewMode } from "../stores/editor";
import { getProjectStore } from "../stores/project";
import { logStore } from "../stores/log";
import "../../styles/components/toolbar.scss";

defineEmits<{
  goHome: [];
}>();

const store = getEditorStore();
const projectStore = getProjectStore();
const { state, engine } = store;

const VIEW_TABS: { key: ViewMode; label: string }[] = [
  { key: "scene", label: "场景" },
  { key: "preview", label: "预览" },
  { key: "script", label: "脚本" },
];

const projectName = computed(() => projectStore.projectName ?? "未命名项目");

function setViewMode(mode: ViewMode): void {
  store.setViewMode(mode);
}

async function save(): Promise<void> {
  const path = projectStore.currentPath;
  if (!path) {
    logStore.log("warn", "尚未打开项目，无法保存", "toolbar");
    return;
  }
  let data: unknown = null;
  try {
    data = JSON.parse(projectStore.sceneJson ?? "");
  } catch {
    data = null;
  }
  const out = { ...(data && typeof data === "object" ? (data as object) : {}), root: engine.graph.toJSON() };
  try {
    await invoke("write_text", { root: path, rel: "assets/Main.scene", content: JSON.stringify(out, null, 2) });
    logStore.log("success", "场景已保存", "toolbar");
  } catch (e) {
    console.error("Failed to save scene:", e);
    logStore.log("error", "场景保存失败", "toolbar");
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
