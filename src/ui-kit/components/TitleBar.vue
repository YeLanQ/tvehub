<script setup lang="ts">
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "../../lib/tauri-env";
import WindowControls from "./WindowControls.vue";
import "../styles/components/title-bar.scss";

const props = withDefaults(
  defineProps<{
    title?: string;
    closable?: boolean;
    minimizable?: boolean;
    maximizable?: boolean;
  }>(),
  {
    title: "",
    closable: true,
    minimizable: true,
    maximizable: true,
  },
);

// 浏览器直开（无 __TAURI_INTERNALS__）时 getCurrentWindow 会抛错：先判环境再取句柄
const inTauri = isTauri();
const win = inTauri ? getCurrentWindow() : null;

/** 拖拽区域 mousedown：启动窗口原生拖拽 */
function onDragDown(e: MouseEvent): void {
  if (!inTauri || e.button !== 0) return;
  void win?.startDragging();
}

/** 双击标题栏切换最大化 */
function onDragDblClick(): void {
  if (!inTauri || !props.maximizable) return;
  void win?.toggleMaximize();
}
</script>

<template>
  <div class="title-bar">
    <div
      class="title-bar-drag"
      data-tauri-drag-region
      @mousedown="onDragDown"
      @dblclick="onDragDblClick"
    >
      <span v-if="props.title" class="title-bar-title">{{ props.title }}</span>
    </div>
    <WindowControls
      :closable="props.closable"
      :minimizable="props.minimizable"
      :maximizable="props.maximizable"
    />
  </div>
</template>
