<script setup lang="ts">
import Toolbar from "./app/components/Toolbar.vue";
import Viewport from "./app/components/Viewport.vue";
import HierarchyPanel from "./app/components/HierarchyPanel.vue";
import InspectorPanel from "./app/components/InspectorPanel.vue";
import HistoryPanel from "./app/components/HistoryPanel.vue";
</script>

<template>
  <div class="editor">
    <header class="editor__bar"><Toolbar /></header>
    <main class="editor__main">
      <aside class="editor__left"><HierarchyPanel /></aside>
      <section class="editor__center">
        <div class="editor__viewport"><Viewport /></div>
        <div class="editor__history"><HistoryPanel /></div>
      </section>
      <aside class="editor__right"><InspectorPanel /></aside>
    </main>
  </div>
</template>

<style scoped>
.editor {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.editor__bar {
  flex: 0 0 auto;
}

.editor__main {
  flex: 1;
  display: flex;
  min-height: 0;
}

.editor__left {
  flex: 0 0 240px;
}

.editor__right {
  flex: 0 0 300px;
}

.editor__center {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.editor__viewport {
  flex: 1;
  min-height: 0;
}

.editor__history {
  flex: 0 0 180px;
  border-top: 1px solid var(--border);
}

.editor__left,
.editor__center,
.editor__right {
  border-right: 1px solid var(--border);
}

.editor__left > *,
.editor__right > * {
  height: 100%;
}

.editor__right {
  border-right: none;
}

@media (max-width: 900px) {
  .editor__main {
    flex-direction: column;
  }
  .editor__left,
  .editor__right {
    flex: 0 0 auto;
  }
}
</style>
