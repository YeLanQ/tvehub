<script setup lang="ts">
/**
 * 导航代理卡（NavAgentNode）：
 * - Area：绑定的导航区域（场景导航区域下拉；空 = 自动取第一个已烘焙区域）；
 * - Movement：移动速度 / 碰撞半径（SDF 净空）；
 * - Targets：移动模式（顺序巡回 / 最近可达目标）+ 巡回循环开关 + 目标节点
 *   多选（浮动下拉；勾选顺序 = 巡回顺序；列表随场景保存）；
 * - 路径动作：「开始移动」按模式启动（sequence 从第一个目标起依次接力，
 *   nearest 走向路径最短的可达目标）/「停止」清路径；
 *   路径与行进是运行态（不进场景），路径折线在视口以辅助线显示（选中时）。
 * 事件统一 emit("update", label, value)，label 即撤销历史文案。
 */
import { computed, ref } from "vue";
import type { NavAgentNode } from "../../../framework/prototype/derived/Primitives";
import { NavAreaNode } from "../../../framework/prototype/derived/Primitives";
import { NAV_AGENT_LIMITS } from "../../../framework/navigation";
import { getEditorStore } from "../../stores/editor";
import { logStore } from "../../stores/log";
import NumberField from "../NumberField.vue";
import NodeMultiSelect from "./NodeMultiSelect.vue";

const props = defineProps<{ node: NavAgentNode; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

const L = NAV_AGENT_LIMITS;

const s = computed(() => {
  void props.rev;
  return props.node.settings;
});

const editor = () => getEditorStore().engine;

/** 场景中的导航区域节点（绑定候选） */
const areas = computed(() => {
  void props.rev;
  return editor().graph.all().filter((n): n is NavAreaNode => n instanceof NavAreaNode);
});

const areaListed = computed(() => {
  const cur = s.value.areaId;
  if (!cur) return true;
  return areas.value.some((a) => a.id === cur);
});

/** 目标候选排除：代理自身及其子树（不能以自己为目标） */
const excludeIds = computed(() => {
  void props.rev;
  const g = editor().graph;
  return g
    .all()
    .filter((n) => n.id === props.node.id || g.isDescendant(props.node.id, n.id))
    .map((n) => n.id);
});

const lastResult = ref<"" | "ok" | "fail" | "noArea">("");

/** 开始移动：按移动模式启动（巡回 / 最近可达；目标列表见 Targets） */
function onStart(): void {
  const ok = editor().nav.startAgent(props.node.id);
  lastResult.value = ok ? "ok" : "fail";
  if (ok) {
    logStore.log("success", "代理开始沿路径移动（可在视口查看路径线）");
  } else {
    logStore.log("warn", "启动失败：需要已烘焙的导航区域与可达的目标节点");
  }
}

function onStop(): void {
  editor().nav.clearPath(props.node.id);
  lastResult.value = "";
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
</script>

<template>
  <div class="terrain-section" :data-rev="rev">
    <!-- ===== Area ===== -->
    <div class="ts-group">Area</div>
    <div class="field">
      <label title="绑定的导航区域；空 = 自动使用场景第一个已烘焙区域">Target</label>
      <select :value="s.areaId" @change="emit('update', 'Bind Nav Area', ($event.target as HTMLSelectElement).value)">
        <option value="">（自动：第一个区域）</option>
        <option v-if="!areaListed" :value="s.areaId">（已删除的区域）</option>
        <option v-for="a in areas" :key="a.id" :value="a.id" :title="a.name">
          {{ a.name }}
        </option>
      </select>
    </div>

    <!-- ===== Movement ===== -->
    <div class="ts-group">Movement</div>
    <div class="field">
      <label title="沿路径的移动速度（世界单位/秒）">Speed</label>
      <NumberField
        :model-value="s.speed"
        :step="0.5"
        :min="L.speed.min"
        :max="L.speed.max"
        title="移动速度（世界单位/秒）"
        @commit="(v) => emit('update', 'Set Speed', clamp(v, L.speed.min, L.speed.max))"
      />
    </div>
    <div class="field">
      <label title="碰撞半径：与障碍距离不足时沿 SDF 梯度滑移避障">Radius</label>
      <NumberField
        :model-value="s.radius"
        :step="0.1"
        :min="L.radius.min"
        :max="L.radius.max"
        title="碰撞半径（世界单位）"
        @commit="(v) => emit('update', 'Set Agent Size', clamp(v, L.radius.min, L.radius.max))"
      />
    </div>

    <!-- ===== Targets ===== -->
    <div class="ts-group">Targets</div>
    <div class="field">
      <label title="顺序巡回 = 按勾选顺序依次走到每个目标；最近可达 = 恒走向路径最短的可达目标">Mode</label>
      <select
        :value="s.moveMode"
        @change="emit('update', 'Set Agent Move Mode', ($event.target as HTMLSelectElement).value)"
      >
        <option value="sequence">顺序巡回</option>
        <option value="nearest">最近可达目标</option>
      </select>
    </div>
    <div v-if="s.moveMode === 'sequence'" class="field">
      <label title="走完一轮目标后回到第一个目标继续巡逻（默认开启；关闭 = 走完最后一个目标后停下）">Loop</label>
      <input
        type="checkbox"
        :checked="s.loop"
        title="巡回循环开关（默认开启 = 持续巡逻）"
        @change="emit('update', 'Toggle Agent Loop', ($event.target as HTMLInputElement).checked)"
      />
    </div>
    <div class="field">
      <label title="目标节点（可多选）：位置取节点世界坐标；勾选顺序 = 巡回顺序">Points</label>
      <NodeMultiSelect
        :selected-ids="s.targetIds"
        :rev="rev"
        :exclude-ids="excludeIds"
        placeholder="未设置目标"
        placeholder-title="未选择目标节点"
        @update="(ids) => emit('update', 'Set Agent Targets', ids)"
      />
    </div>

    <!-- ===== 路径动作 ===== -->
    <div class="ts-group">Path</div>
    <div class="ts-actions">
      <button title="按移动模式启动：巡回从第一个目标起依次接力（跳过不可达）；最近可达走向路径最短的目标" @click="onStart">
        开始移动
      </button>
      <button title="清除当前路径，代理停下" @click="onStop">停止</button>
    </div>
    <div class="ts-actions">
      <span v-if="lastResult === 'ok'" class="hint">移动中…（目标节点移动后自动重新寻路）</span>
      <span v-else-if="lastResult === 'fail'" class="hint">启动失败：检查导航区域与目标节点</span>
      <span v-else class="hint">路径是运行态：移动/避障由烘焙 SDF 查表驱动，不写场景数据</span>
    </div>
  </div>
</template>

<style scoped>
.ts-group {
  margin: 8px 0 2px;
  padding-top: 4px;
  font-size: 10px;
  letter-spacing: 0.4px;
  color: var(--text-dim, #999);
  border-top: 1px solid var(--border, #333);
}
.ts-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0 4px;
}
.ts-actions button {
  flex: none;
  font-size: 11px;
  line-height: 1.2;
  padding: 3px 8px;
  border-radius: 3px;
  border: 1px solid var(--text-dim, #666);
  background: transparent;
  color: var(--text, #ddd);
  cursor: pointer;
}
.ts-actions button:hover {
  border-color: var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
.ts-actions .hint {
  font-size: 10px;
  color: var(--text-dim, #888);
}
</style>
