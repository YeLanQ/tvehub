<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { disposeEditor, mountEditor } from "../stores/editor";

const host = ref<HTMLDivElement | null>(null);

onMounted(() => {
  if (host.value) mountEditor(host.value);
});

onBeforeUnmount(() => {
  disposeEditor();
});

</script>

<template>
  <div ref="host" class="viewport">
    <div class="viewport__hint mono muted">
      视口：左键选择 · 拖拽 Gizmo 变换 · 右侧 Inspector 编辑
    </div>
  </div>
</template>

<style scoped>
.viewport {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 200px;
  background: #000;
}

.viewport__hint {
  position: absolute;
  left: 10px;
  bottom: 8px;
  pointer-events: none;
  opacity: 0.6;
}
</style>