<script setup lang="ts">
import { computed, ref } from "vue";
import { logStore, type ConsoleLevel } from "../stores/log";
import "../../styles/components/console-panel.scss";

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
