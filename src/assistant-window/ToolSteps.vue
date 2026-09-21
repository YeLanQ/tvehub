<script setup lang="ts">
// 执行过程面板：一轮里的工具调用按「一次调用一行」折叠展示。
// 行 = 方法名 + 参数摘要 + 状态（运行中转点 / ✓ / ✗）+ 结果摘要；
// 全文走 title 悬浮。默认收敛成一行摘要（滚动收敛）；busy 且是最新块时
// 自动展开跟随，展开后内容区限高滚动。
import { computed } from "vue";

export interface ToolStepItem {
  /** 行键：调用 id（结果原位更新到同一行） */
  id: string;
  toolName: string;
  args: string;
  result?: string;
  ok?: boolean;
}

const props = defineProps<{
  items: ToolStepItem[];
  open: boolean;
  running?: boolean;
}>();

const emit = defineEmits<{ toggle: [] }>();

const label = computed(() => (props.running ? "执行中" : "执行过程"));

const ARGS_LIMIT = 72;
const RESULT_LIMIT = 48;

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function brief(text: string | undefined, limit: number): string {
  if (!text) return "";
  const line = oneLine(text);
  return line.length > limit ? line.slice(0, limit) + "…" : line;
}
</script>

<template>
  <div class="asteps" :class="{ running }">
    <button class="asteps-head" :title="open ? '收起执行过程' : '展开执行过程'" @click="emit('toggle')">
      <span class="asteps-icon">⚙</span>
      <span>{{ label }} · {{ items.length }} 步</span>
      <span v-if="running" class="asteps-dot" />
      <span class="asteps-arrow">{{ open ? "▾" : "▸" }}</span>
    </button>
    <div v-if="open" class="asteps-body">
      <div v-for="t in items" :key="t.id" class="asteps-item">
        <b>{{ t.toolName }}</b>
        <span class="asteps-args" :title="t.args">{{ brief(t.args, ARGS_LIMIT) }}</span>
        <span v-if="t.result === undefined" class="asteps-spin" title="执行中">⋯</span>
        <template v-else>
          <span class="asteps-ok" :class="{ bad: !t.ok }">{{ t.ok ? "✓" : "✗" }}</span>
          <span class="asteps-res" :title="t.result">{{ brief(t.result, RESULT_LIMIT) }}</span>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.asteps {
  margin: 6px 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-input);
  overflow: hidden;
  &.running { border-color: var(--accent); }
}
.asteps-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 8px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 11px;
  cursor: pointer;
  &:hover { color: var(--text); background: var(--bg-hover); }
}
.asteps-icon { font-size: 11px; }
.asteps-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--accent);
  animation: asteps-pulse 1s infinite;
}
@keyframes asteps-pulse { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }
.asteps-arrow { margin-left: auto; }
.asteps-body {
  max-height: 180px;
  overflow-y: auto;
  border-top: 1px solid var(--border);
  padding: 4px 8px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.asteps-item {
  font: 11px/1.6 ui-monospace, Consolas, monospace;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  b { color: var(--text-dim); font-weight: 600; margin-right: 6px; }
}
.asteps-args { color: var(--text-dim); }
.asteps-spin { margin: 0 4px; color: var(--accent); animation: asteps-pulse 0.8s infinite; }
.asteps-ok { margin: 0 4px; color: var(--ok); &.bad { color: var(--err); } }
.asteps-res { color: var(--text-dim); }
</style>
