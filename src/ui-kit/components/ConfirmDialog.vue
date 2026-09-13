<script setup lang="ts">
import { onBeforeUnmount, watch } from "vue";
import { confirmState, closeConfirm } from "../composables/confirm";
import "../styles/components/confirm-dialog.scss";

function onWindowKey(e: KeyboardEvent) {
  if (!confirmState.open) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closeConfirm(false);
  } else if (e.key === "Enter") {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "BUTTON" || tag === "INPUT" || tag === "TEXTAREA") return;
    e.preventDefault();
    closeConfirm(true);
  }
}

watch(
  () => confirmState.open,
  (open) => {
    if (open) window.addEventListener("keydown", onWindowKey, true);
    else window.removeEventListener("keydown", onWindowKey, true);
  },
);

onBeforeUnmount(() => window.removeEventListener("keydown", onWindowKey, true));
</script>

<template>
  <Teleport to="body">
    <div
      v-if="confirmState.open"
      class="confirm-backdrop"
      @mousedown.self="closeConfirm(false)"
    >
      <div class="confirm-dialog" role="alertdialog" aria-modal="true">
        <h3>{{ confirmState.options.title }}</h3>
        <p class="msg">{{ confirmState.options.message }}</p>
        <div class="actions">
          <button @click="closeConfirm(false)">
            {{ confirmState.options.cancelText }}
          </button>
          <button
            class="primary"
            :class="{ danger: confirmState.options.danger }"
            @click="closeConfirm(true)"
          >
            {{ confirmState.options.confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>