<script setup lang="ts">
/**
 * 全局模态输入/确认（图窗口版）：Tauri WebView 无可靠原生 prompt/confirm，
 * store.askText / askConfirm 经这里承载。Enter 确认、Esc 取消。
 */
import { nextTick, ref, watch } from "vue";
import { getGraphWindowStore } from "../graphStore";

const store = getGraphWindowStore();
const inputRef = ref<HTMLInputElement | null>(null);

watch(
  () => store.modal.open,
  async (open) => {
    if (open && store.modal.mode === "text") {
      await nextTick();
      inputRef.value?.focus();
      inputRef.value?.select();
    }
  },
);

function ok(): void {
  const m = store.modal;
  m.resolve?.(m.mode === "text" ? m.value : "ok");
  m.resolve = null;
  m.open = false;
}

function cancel(): void {
  const m = store.modal;
  m.resolve?.(null);
  m.resolve = null;
  m.open = false;
}
</script>

<template>
  <div v-if="store.modal.open" class="gmodal-mask" @click.self="cancel()">
    <div class="gmodal" :class="{ danger: store.modal.danger }">
      <div class="gmodal-title">{{ store.modal.title }}</div>
      <label class="gmodal-label">{{ store.modal.label }}</label>
      <input
        v-if="store.modal.mode === 'text'"
        ref="inputRef"
        v-model="store.modal.value"
        class="gmodal-input"
        @keydown.enter.prevent="ok()"
        @keydown.esc.prevent="cancel()"
      />
      <div class="gmodal-actions">
        <button @click="cancel()">取消</button>
        <button :class="{ danger: store.modal.danger }" @click="ok()">确定</button>
      </div>
    </div>
  </div>
</template>
