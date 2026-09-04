<script setup lang="ts">
import { computed } from "vue";
import { getEditorStore } from "../stores/editor";
import "../../styles/components/toolbar.scss";

defineEmits<{
  goHome: [];
}>();

const store = getEditorStore();
const { state, engine } = store;

const hasSelection = computed(() => !!state.selectedId);

function del(): void {
  engine.deleteSelected();
}
</script>

<template>
  <div class="toolbar-groups">
    <div class="group">
      <button @click="$emit('goHome')" title="返回项目管理器">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">
          <path d="M2 8h12M6 4l-4 4 4 4" />
        </svg>
        <span>项目</span>
      </button>
    </div>

    <div class="spacer"></div>

    <!-- 右侧：历史 + 删除 -->
    <div class="group">
      <button :disabled="!state.canUndo" @click="engine.undo()">
        Undo · {{ state.undoLabel ?? "—" }}
      </button>
      <button :disabled="!state.canRedo" @click="engine.redo()">Redo</button>
      <button :disabled="!hasSelection" class="danger" @click="del">Delete</button>
    </div>
  </div>
</template>
