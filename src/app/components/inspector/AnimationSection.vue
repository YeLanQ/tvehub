<script setup lang="ts">
/**
 * Animation 卡片（source=model 的网格）：
 * - 模式：关闭 / 单剪辑（直控一个剪辑：自动播放/速度/循环）/ 动画图（状态机）；
 * - 单剪辑参数为节点数据（随场景保存）；播放/暂停/停止为运行时控制（不落盘）；
 * - 动画图模式下嵌 AnimGraphSection 编辑器（状态/过渡/参数）。
 */
import { computed } from "vue";
import { MeshNode } from "../../../framework/prototype/derived/Primitives";
import type { AnimGraph } from "../../../framework/animation";
import { getEditorStore } from "../../stores/editor";
import NumberField from "../NumberField.vue";
import AnimGraphSection from "./AnimGraphSection.vue";

const props = defineProps<{ node: MeshNode; rev?: number }>();

const emit = defineEmits<{
  updateAnim: [label: string, value: unknown];
  updateGraph: [graph: AnimGraph | null];
}>();

const editorStore = getEditorStore();
const engine = editorStore.engine;

/** 模型解析状态（剪辑列表/骨骼标记/错误信息；随 model:changed 的 rev 刷新） */
const modelMeta = computed(() => {
  void props.rev;
  return props.node.model ? engine.models.metaFor(props.node.model) : null;
});
const modelError = computed(() => {
  void props.rev;
  return props.node.model ? engine.models.errorFor(props.node.model) : null;
});
/** 可选剪辑（未就绪为空数组；下拉保留当前值兜底） */
const clips = computed(() => modelMeta.value?.clips ?? []);

/** 模式：图 > 单剪辑 > 关闭 */
const mode = computed<"off" | "clip" | "graph">(() => {
  void props.rev;
  if (props.node.animGraph) return "graph";
  return props.node.anim.autoplay ? "clip" : "off";
});

/** 运行时状态（当前剪辑/图状态/播放中；随 animation:changed 的 rev 刷新） */
const runtime = computed(() => {
  void props.rev;
  return engine.animation.stateFor(props.node.id);
});

function onModeChange(e: Event): void {
  const value = (e.target as HTMLSelectElement).value as "off" | "clip" | "graph";
  if (value === "graph") {
    // 新建默认图：单状态 Idle 绑定首个剪辑（无剪辑则保持姿势），入口即它
    const first = clips.value[0] ?? "";
    emit("updateGraph", {
      entry: "Idle",
      states: [{ name: "Idle", clip: first, speed: 1, loop: "loop" }],
      transitions: [],
      params: {},
    });
    return;
  }
  if (value === "clip") {
    emit("updateGraph", null);
    emit("updateAnim", "Set Anim Autoplay", true);
    return;
  }
  emit("updateGraph", null);
  emit("updateAnim", "Set Anim Autoplay", false);
}

function onClipChange(e: Event): void {
  emit("updateAnim", "Set Anim Clip", (e.target as HTMLSelectElement).value);
}

function onLoopChange(e: Event): void {
  emit("updateAnim", "Set Anim Loop", (e.target as HTMLSelectElement).value);
}

function onSpeedChange(v: number): void {
  emit("updateAnim", "Set Anim Speed", Math.max(0, v));
}

function onAutoplayChange(e: Event): void {
  emit("updateAnim", "Set Anim Autoplay", (e.target as HTMLInputElement).checked);
}

// —— 运行时控制（不落盘）——
function rtPlay(): void {
  engine.animation.play(props.node.id);
}
function rtPause(): void {
  engine.animation.pause(props.node.id);
}
function rtStop(): void {
  engine.animation.stop(props.node.id);
}
</script>

<template>
  <div class="anim-section" :data-rev="rev">
    <div class="field">
      <label>动画模式</label>
      <select :value="mode" :disabled="!modelMeta" @change="onModeChange($event)">
        <option value="off">关闭（Off）</option>
        <option value="clip">单剪辑（Clip）</option>
        <option value="graph">动画图（Graph）</option>
      </select>
    </div>

    <div v-if="modelError" class="hint error">模型加载失败: {{ modelError }}</div>
    <div v-else-if="!modelMeta" class="hint">模型解析中（或未选择模型）…</div>
    <div v-else-if="clips.length === 0" class="hint">该模型不含动画剪辑（静态模型）。</div>

    <template v-if="modelMeta && mode === 'clip' && clips.length > 0">
      <label class="anim-toggle" @click.stop>
        <input type="checkbox" :checked="node.anim.autoplay" @change="onAutoplayChange($event)" />
        <span>自动播放</span>
      </label>
      <div class="field">
        <label>剪辑</label>
        <select :value="node.anim.clip" @change="onClipChange($event)">
          <option value="">（首个剪辑）</option>
          <option
            v-for="c in clips"
            :key="c"
            :value="c"
            :selected="c === node.anim.clip"
          >{{ c }}</option>
        </select>
      </div>
      <div class="field">
        <label>速度</label>
        <NumberField
          :model-value="node.anim.speed"
          :step="0.05"
          :min="0"
          :max="10"
          @commit="onSpeedChange"
        />
      </div>
      <div class="field">
        <label>循环</label>
        <select :value="node.anim.loop" @change="onLoopChange($event)">
          <option value="loop">循环</option>
          <option value="once">一次</option>
          <option value="pingpong">往复</option>
        </select>
      </div>
    </template>

    <!-- 运行时控制 + 状态显示 -->
    <div v-if="modelMeta && clips.length > 0" class="anim-runtime">
      <div class="anim-btns">
        <button title="播放" @click="rtPlay">▶</button>
        <button title="暂停" @click="rtPause">⏸</button>
        <button title="停止" @click="rtStop">⏹</button>
      </div>
      <span v-if="runtime" class="anim-state mono">
        {{
          mode === "graph"
            ? `图: ${runtime.graphState ?? "-"}${runtime.playing ? "" : "（暂停）"}`
            : `${runtime.clip ?? "-"}${runtime.playing ? "" : "（暂停）"}`
        }}
      </span>
    </div>

    <!-- 动画图编辑器 -->
    <AnimGraphSection
      v-if="mode === 'graph' && node.animGraph"
      :node="node"
      :rev="rev"
      :clips="clips"
      @updateGraph="(g) => emit('updateGraph', g)"
    />
  </div>
</template>

<style scoped>
.anim-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text, #ddd);
  cursor: pointer;
  padding: 2px 0;
}
.anim-runtime {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0 2px;
  border-top: 1px solid var(--border, #333);
  margin-top: 4px;
}
.anim-btns {
  display: inline-flex;
  gap: 4px;
  flex: none;
}
.anim-btns button {
  font-size: 11px;
  line-height: 1.2;
  padding: 3px 8px;
  border-radius: 3px;
  border: 1px solid var(--text-dim, #666);
  background: transparent;
  color: var(--text, #ddd);
  cursor: pointer;
}
.anim-btns button:hover {
  border-color: var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
.anim-state {
  flex: 1 1 auto;
  min-width: 60px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text-dim, #999);
}
.hint.error {
  color: #e06c5a;
}
</style>
