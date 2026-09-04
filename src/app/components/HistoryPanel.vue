<script setup lang="ts">
import { getEditorStore } from "../stores/editor";

const { state, engine } = getEditorStore();

function undo(): void {
  engine.undo();
}

function redo(): void {
  engine.redo();
}
</script>

<template>
  <div class="panel history">
    <div class="bar">
      <button :disabled="!state.canUndo" @click="undo">
        ← Undo {{ state.undoLabel ?? "—" }}
      </button>
      <button :disabled="!state.canRedo" @click="redo">
        Redo {{ state.redoLabel ?? "—" }} →
      </button>
      <span class="count mono">
        depth {{ state.historyDepth }} · canUndo {{ state.canUndo }} · canRedo {{ state.canRedo }}
      </span>
    </div>
    <ol class="stack mono">
      <li v-for="(label, i) in state.historyLabels.slice().reverse()" :key="i" class="entry">
        <span class="idx">#{{ state.historyLabels.length - i }}</span>
        <span class="label">{{ label }}</span>
      </li>
      <li v-if="!state.historyLabels.length" class="empty muted">栈为空 · 执行操作即入栈</li>
    </ol>
  </div>
</template>

<style scoped>
.history {
  min-height: 120px;
}

.count {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-dim);
}

.bar {
  display: flex;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid var(--border);
}

.stack {
  list-style: none;
  margin: 0;
  padding: 6px 8px;
  overflow: auto;
  flex: 1;
  font-size: 11px;
}

.entry {
  display: flex;
  gap: 8px;
  padding: 2px 0;
}

.idx {
  color: var(--text-dim);
  width: 34px;
}

.label {
  color: var(--text);
}

.empty {
  font-size: 12px;
}
</style>