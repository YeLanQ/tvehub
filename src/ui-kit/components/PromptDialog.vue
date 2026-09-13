<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { promptState, closePrompt } from "../composables/prompt";
import "../styles/components/prompt-dialog.scss";

const inputEl = ref<HTMLInputElement | null>(null);

function onWindowKey(e: KeyboardEvent) {
  if (!promptState.open) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closePrompt(null);
  }
}

watch(
  () => promptState.open,
  async (open) => {
    if (open) {
      window.addEventListener("keydown", onWindowKey, true);
      await nextTick();
      inputEl.value?.focus();
      inputEl.value?.select();
    } else {
      window.removeEventListener("keydown", onWindowKey, true);
    }
  },
);

onBeforeUnmount(() => window.removeEventListener("keydown", onWindowKey, true));

function submit() {
  const v = promptState.value.trim();
  closePrompt(v === "" ? null : v);
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="promptState.open"
      class="prompt-backdrop"
      @mousedown.self="closePrompt(null)"
    >
      <div class="prompt-dialog" role="dialog" aria-modal="true">
        <h3>{{ promptState.options.title }}</h3>
        <div class="row">
          <label v-if="promptState.options.label">{{ promptState.options.label }}</label>
          <input
            ref="inputEl"
            v-model="promptState.value"
            :placeholder="promptState.options.placeholder"
            @keydown.enter.prevent="submit"
          />
        </div>
        <div class="actions">
          <button @click="closePrompt(null)">
            {{ promptState.options.cancelText }}
          </button>
          <button class="primary" @click="submit">
            {{ promptState.options.confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>