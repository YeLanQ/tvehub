<script setup lang="ts">
import { onBeforeUnmount, watch } from "vue";
import {
  closeDracoCompressDialog,
  dracoCompressState,
  formatBytes,
} from "../composables/draco-compress";
import "../styles/components/draco-compress-dialog.scss";

function onWindowKey(e: KeyboardEvent) {
  if (!dracoCompressState.open) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closeDracoCompressDialog(null);
  }
}

watch(
  () => dracoCompressState.open,
  (open) => {
    if (open) window.addEventListener("keydown", onWindowKey, true);
    else window.removeEventListener("keydown", onWindowKey, true);
  },
);

onBeforeUnmount(() => window.removeEventListener("keydown", onWindowKey, true));

function submit() {
  closeDracoCompressDialog({
    speed: dracoCompressState.speed,
    quality: dracoCompressState.quality,
  });
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="dracoCompressState.open"
      class="prompt-backdrop"
      @mousedown.self="closeDracoCompressDialog(null)"
    >
      <div class="prompt-dialog" role="dialog" aria-modal="true">
        <h3>{{ dracoCompressState.options.title }}</h3>
        <div class="row">
          <label>源文件</label>
          <span class="hint">{{ formatBytes(dracoCompressState.options.sourceSize) }}</span>
        </div>
        <div class="row">
          <label>编码速度</label>
          <input
            v-model.number="dracoCompressState.speed"
            type="range"
            min="0"
            max="10"
            step="1"
          />
          <span class="hint mono">{{ dracoCompressState.speed }}</span>
        </div>
        <div class="row">
          <label>速度说明</label>
          <span class="hint">0 最慢、压缩率最高；10 最快、体积偏大</span>
        </div>
        <div class="row">
          <label>量化精度</label>
          <select v-model="dracoCompressState.quality">
            <option value="standard">标准（位置 14 / 法线 10 / UV 12 位）</option>
            <option value="high">高精度（位置 16 / 法线 12 / UV 14 位）</option>
          </select>
        </div>
        <div class="row">
          <label>说明</label>
          <span class="hint">压缩只作用于网格几何，生成新文件，不影响原资产</span>
        </div>
        <div class="actions">
          <button @click="closeDracoCompressDialog(null)">
            {{ dracoCompressState.options.cancelText }}
          </button>
          <button class="primary" @click="submit">
            {{ dracoCompressState.options.confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
