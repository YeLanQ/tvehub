<script setup lang="ts">
import { computed, ref } from "vue";
import { logStore, type ConsoleLevel } from "../stores/log";

const LEVELS: ConsoleLevel[] = ["info", "warn", "error", "engine", "success"];

const LEVEL_LABELS: Record<ConsoleLevel, string> = {
  info: "信息",
  warn: "警告",
  error: "错误",
  engine: "引擎",
  success: "成功",
};

const LEVEL_ICONS: Record<ConsoleLevel, string> = {
  info: "ⓘ",
  warn: "⚠",
  error: "✖",
  engine: "⚙",
  success: "✓",
};

const active = ref<ConsoleLevel | null>(null);

const lines = computed(() => {
  if (!active.value) return logStore.lines;
  return logStore.lines.filter((l) => l.level === active.value);
});

function toggle(lv: ConsoleLevel): void {
  active.value = active.value === lv ? null : lv;
}

function clearAll(): void {
  logStore.clear();
}
</script>

<template>
  <div class="panel console">
    <div class="console-filter">
      <button
        v-for="lv in LEVELS"
        :key="lv"
        class="mini"
        :class="{ active: active === lv }"
        @click="toggle(lv)"
      >
        {{ LEVEL_ICONS[lv] }} {{ LEVEL_LABELS[lv] }}
      </button>
      <span class="spacer"></span>
      <span class="count mono">{{ lines.length }} / {{ logStore.lines.length }}</span>
      <button class="mini" title="清空控制台" @click="clearAll">清除</button>
    </div>
    <div class="lines mono">
      <div v-for="(l, i) in lines" :key="i" class="line" :class="'lvl-' + l.level">
        <span class="icon">{{ LEVEL_ICONS[l.level] }}</span>
        <span v-if="l.tag" class="tag">[{{ l.tag }}]</span>
        <span class="text">{{ l.text }}</span>
        <span class="time">{{ l.time }}</span>
      </div>
      <div v-if="!lines.length" class="empty">无日志</div>
    </div>
  </div>
</template>

<style scoped>
.console {
  min-height: 120px;
}

.console-filter {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.console-filter .mini {
  padding: 2px 8px;
  font-size: 11px;
}

.console-filter .mini.active {
  background: var(--bg-active);
  color: var(--text);
  font-weight: 600;
}

.spacer {
  flex: 1;
}

.count {
  font-size: 11px;
  color: var(--text-dim);
}

.lines {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  overflow: auto;
  flex: 1;
  font-size: 11px;
  line-height: 1.7;
  user-select: all !important;
}

.line {
  display: flex;
  gap: 6px;
  padding: 0 10px;
  white-space: nowrap;
  user-select: all !important;
}

.line:hover {
  background: var(--bg-hover);
}

.icon {
  width: 14px;
  text-align: center;
  flex-shrink: 0;
}

.tag {
  color: var(--text-dim);
  flex-shrink: 0;
}

.text {
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
}

.time {
  margin-left: auto;
  color: var(--text-dim);
  flex-shrink: 0;
}

.lvl-error .icon,
.lvl-error .text {
  color: var(--err);
}

.lvl-warn .icon,
.lvl-warn .text {
  color: var(--warn);
}

.lvl-success .icon,
.lvl-success .text {
  color: var(--ok);
}

.lvl-engine .icon {
  color: var(--text-dim);
}

.empty {
  padding: 10px;
  font-size: 12px;
  color: var(--text-dim);
}
</style>