<script setup lang="ts">
// 大脑语义单元化过程块（过程容器）：上半是处理轨迹（分段 → 神经图检索 →
// 单元化），下半是单元任务行（序号 + 阶段 + 文本 + 预测方法 + 区域 + 状态）。
// 运行中由 AssistantChat 的 nluRun 驱动实时状态；历史回放为静态计划
//（running=false，状态一律 pending→不显示状态符）。
import { computed, ref, watch } from "vue";

export interface NluUnitRow {
  /** 1 起始序号（与 BrainTaskUnit.index 对应） */
  index: number;
  text: string;
  method?: string | null;
  zone?: "green" | "yellow" | "red" | null;
  phase: "inspect" | "act" | "verify";
  status: "pending" | "running" | "ok" | "fail";
}

export interface NluBlockData {
  traces: Array<{ stage: string; detail: string }>;
  units: NluUnitRow[];
}

const props = defineProps<{
  data: NluBlockData;
  open: boolean;
  running?: boolean;
}>();

const emit = defineEmits<{ toggle: [] }>();

const label = computed(() => (props.running ? "大脑·语义单元化中" : "大脑·语义单元化"));

const PHASE_SHORT: Record<NluUnitRow["phase"], string> = {
  inspect: "调研",
  act: "执行",
  verify: "验证",
};

const STATUS_MARK: Record<NluUnitRow["status"], string> = {
  pending: "",
  running: "⋯",
  ok: "✓",
  fail: "✗",
};

function unitText(text: string, limit = 64): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > limit ? line.slice(0, limit) + "…" : line;
}

const bodyEl = ref<HTMLElement | null>(null);
watch(
  () => props.data.units.map((u) => u.status).join(),
  async () => {
    if (!props.open || !props.running) return;
    const el = bodyEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
);
</script>

<template>
  <div class="anlu" :class="{ running }">
    <button class="anlu-head" :title="open ? '收起大脑过程' : '展开大脑过程'" @click="emit('toggle')">
      <span class="anlu-icon">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
          <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
          <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
          <path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
          <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
          <path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
          <path d="M19.938 10.5a4 4 0 0 1 .585.396" />
          <path d="M6 18a4 4 0 0 1-1.967-.516" />
          <path d="M19.967 17.484A4 4 0 0 1 18 18" />
        </svg>
      </span>
      <span>{{ label }} · {{ data.units.length }} 单元</span>
      <span v-if="running" class="anlu-dot" />
      <span class="anlu-arrow">{{ open ? "▾" : "▸" }}</span>
    </button>
    <div v-if="open" ref="bodyEl" class="anlu-body">
      <div v-for="(t, i) in data.traces" :key="`t${i}`" class="anlu-trace" :title="`${t.stage}：${t.detail}`">
        <span class="anlu-stage">{{ t.stage }}</span>
        <span>{{ t.detail }}</span>
      </div>
      <div
        v-for="u in data.units"
        :key="`u${u.index}`"
        class="anlu-unit"
        :class="u.status"
        :title="u.text"
      >
        <b>{{ String(u.index).padStart(2, "0") }}</b>
        <span class="anlu-phase" :class="u.phase">{{ PHASE_SHORT[u.phase] }}</span>
        <span class="anlu-text">{{ unitText(u.text) }}</span>
        <span v-if="u.method" class="anlu-method" :title="`预测入口：${u.method}`">→ {{ u.method }}</span>
        <span v-if="u.zone" class="anlu-zone" :class="u.zone" :title="u.zone === 'green' ? '只读' : u.zone === 'yellow' ? '写操作' : '禁止'" />
        <span v-if="running" class="anlu-mark" :class="u.status">{{ STATUS_MARK[u.status] }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.anlu {
  margin: 6px 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-input);
  overflow: hidden;
  &.running { border-color: var(--accent); }
}
.anlu-head {
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
.anlu-icon { font-size: 11px; display: inline-flex;
  svg { flex: none; display: block; }
}
.anlu-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--accent);
  animation: anlu-pulse 1s infinite;
}
@keyframes anlu-pulse { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }
.anlu-arrow { margin-left: auto; }
.anlu-body {
  max-height: 240px;
  overflow-y: auto;
  border-top: 1px solid var(--border);
  padding: 4px 8px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.anlu-trace {
  flex: none; /* 限高容器内禁止行收缩，保住溢出滚动 */
  font: 11px/1.6 ui-monospace, Consolas, monospace;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  .anlu-stage { margin-right: 6px; opacity: 0.75; &::after { content: "·"; margin-left: 6px; } }
}
.anlu-unit {
  flex: none;
  font: 11px/1.6 ui-monospace, Consolas, monospace;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  b { color: var(--text-dim); font-weight: 600; margin-right: 6px; }
  &.running .anlu-text { color: var(--accent); }
}
.anlu-phase {
  flex: none;
  margin-right: 6px;
  padding: 0 4px;
  border-radius: 4px;
  font-size: 10px;
  color: var(--text-dim);
  background: var(--bg-hover);
  &.inspect { color: var(--ok); }
  &.act { color: var(--warn); }
  &.verify { color: var(--accent); }
}
.anlu-text { color: inherit; }
.anlu-method { margin: 0 4px; color: var(--text-dim); }
.anlu-zone {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin: 0 3px;
  display: inline-block;
  &.green { background: var(--ok); }
  &.yellow { background: var(--warn); }
  &.red { background: var(--err); }
}
.anlu-mark {
  margin-left: 4px;
  color: var(--ok);
  &.running { color: var(--accent); animation: anlu-pulse 0.8s infinite; }
  &.fail { color: var(--err); }
}
</style>
