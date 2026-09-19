<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "../../lib/tauri-env";
import "../styles/components/title-bar.scss";

withDefaults(
  defineProps<{
    closable?: boolean;
    minimizable?: boolean;
    maximizable?: boolean;
  }>(),
  {
    closable: true,
    minimizable: true,
    maximizable: true,
  },
);

// 浏览器直开（无 __TAURI_INTERNALS__）时 getCurrentWindow 会抛错：
// 先判环境再取窗口句柄，动作方法已有 inTauri 守卫（win 仅在 Tauri 下非空）
const inTauri = isTauri();
const win = inTauri ? getCurrentWindow() : null;
const maximized = ref(false);

let unlistenMax: UnlistenFn | null = null;

async function syncMaximized(): Promise<void> {
  if (!inTauri) return;
  try {
    maximized.value = (await win?.isMaximized()) ?? false;
  } catch {
    /* ignore */
  }
}

async function onMinimize(): Promise<void> {
  if (!inTauri) return;
  try {
    await win?.minimize();
  } catch {
    /* ignore */
  }
}

async function onToggleMaximize(): Promise<void> {
  if (!inTauri) return;
  try {
    await win?.toggleMaximize();
    await syncMaximized();
  } catch {
    /* ignore */
  }
}

async function onClose(): Promise<void> {
  if (!inTauri) return;
  try {
    await win?.close();
  } catch {
    /* ignore */
  }
}

onMounted(async () => {
  await syncMaximized();
  if (!inTauri) return;
  try {
    unlistenMax = await listen("tauri://resize", () => {
      void syncMaximized();
    });
  } catch {
    /* ignore */
  }
});

onUnmounted(() => {
  unlistenMax?.();
  unlistenMax = null;
});
</script>

<template>
  <div class="title-bar-controls">
    <button
      v-if="minimizable"
      class="title-btn title-btn-min"
      title="最小化"
      @click="onMinimize"
    >
      <svg width="10" height="10" viewBox="0 0 10 10">
        <rect x="1" y="4.5" width="8" height="1" fill="currentColor" />
      </svg>
    </button>
    <button
      v-if="maximizable"
      class="title-btn title-btn-max"
      :title="maximized ? '还原' : '最大化'"
      @click="onToggleMaximize"
    >
      <svg v-if="!maximized" width="10" height="10" viewBox="0 0 10 10">
        <rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1" />
      </svg>
      <svg v-else width="10" height="10" viewBox="0 0 10 10">
        <rect x="2.5" y="1" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1" />
        <rect x="1" y="2.5" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1" />
      </svg>
    </button>
    <button
      v-if="closable"
      class="title-btn title-btn-close"
      title="关闭"
      @click="onClose"
    >
      <svg width="10" height="10" viewBox="0 0 10 10">
        <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1" />
      </svg>
    </button>
  </div>
</template>