<script setup lang="ts">
/**
 * 导航区域卡（NavAreaNode）：
 * - Sources：采样源多选（场景地形 + 网格；多源按最高面合并；全不选 = 自动取
 *   场景第一块地形）；
 * - Baking：网格分辨率 / 代理半径（净空）/ 最大坡度 / 最大高差 / 障碍收集模式；
 * - Display：可视化模式（关闭 / 可行走叠加 / SDF 热力图）；
 * - 状态：烘焙统计（格数/可行走占比/耗时）+ 手动重烘焙按钮（兜底；采样源/
 *   障碍变化已自动按签名重烘焙）。
 * 事件统一 emit("update", label, value)，label 即撤销历史文案；
 * 改设置 → 签名变化 → 导航系统自动重烘焙。
 */
import { computed, ref } from "vue";
import type { NavAreaNode } from "../../../framework/prototype/derived/Primitives";
import { MeshNode, TerrainNode } from "../../../framework/prototype/derived/Primitives";
import type { Node } from "../../../framework/prototype/Node";
import { NAV_AREA_LIMITS } from "../../../framework/navigation";
import { getEditorStore } from "../../stores/editor";
import NumberField from "../NumberField.vue";
import NodeMultiSelect from "./NodeMultiSelect.vue";

const props = defineProps<{ node: NavAreaNode; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

const L = NAV_AREA_LIMITS;

/** 节点是普通类实例（非响应式）：以 rev 为失效信号读取设置 */
const s = computed(() => {
  void props.rev;
  return props.node.settings;
});

const editor = () => getEditorStore().engine;

/** 采样源候选：地形与网格节点 */
function sourceFilter(n: Node): boolean {
  return n instanceof TerrainNode || n instanceof MeshNode;
}

/** 烘焙统计（导航系统在属性变化时自动重烘焙；rev 变化即重读） */
const stats = computed(() => {
  void props.rev;
  return editor().nav.getAreaStats(props.node.id);
});

const baking = ref(false);
/** 手动重烘焙：兜底（采样源/障碍/地形内容变化已自动触发） */
async function onBake(): Promise<void> {
  if (baking.value) return;
  baking.value = true;
  try {
    const r = editor().nav.bakeArea(props.node.id);
    if (!r) logWarn("没有可烘焙的导航区域数据（需要采样源：地形或网格）");
  } finally {
    baking.value = false;
  }
}

function logWarn(msg: string): void {
  // 延迟引用避免循环依赖（logStore 只在动作时用）
  void import("../../stores/log").then(({ logStore }) => logStore.log("warn", msg));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
</script>

<template>
  <div class="terrain-section" :data-rev="rev">
    <!-- ===== Sources ===== -->
    <div class="ts-group">Sources</div>
    <div class="field">
      <label title="采样源（地形或网格，可多选）：可行走面按每格最高面合并；全不选 = 自动使用场景第一块地形">Targets</label>
      <NodeMultiSelect
        :selected-ids="s.sourceIds"
        :rev="rev"
        :filter="sourceFilter"
        placeholder="自动（第一块地形）"
        placeholder-title="未选择采样源：自动使用场景第一块地形"
        @update="(ids) => emit('update', 'Set Nav Sources', ids)"
      />
    </div>

    <!-- ===== Baking ===== -->
    <div class="ts-group">Baking</div>
    <div class="field">
      <label title="一格边长（米）：越小越精细，烘焙与内存开销越大">Cell Size</label>
      <NumberField
        :model-value="s.cellSize"
        :step="0.25"
        :min="L.cellSize.min"
        :max="L.cellSize.max"
        title="网格分辨率（格边长，世界单位）"
        @commit="(v) => emit('update', 'Set Cell Size', clamp(v, L.cellSize.min, L.cellSize.max))"
      />
    </div>
    <div class="field">
      <label title="可行走判定净空：到最近障碍的距离 ≥ 此值的格才可行走">Radius</label>
      <NumberField
        :model-value="s.agentRadius"
        :step="0.1"
        :min="L.agentRadius.min"
        :max="L.agentRadius.max"
        title="代理半径（世界单位）"
        @commit="(v) => emit('update', 'Set Agent Radius', clamp(v, L.agentRadius.min, L.agentRadius.max))"
      />
    </div>
    <div class="field">
      <label title="超过此坡度的格不可行走">Max Slope</label>
      <NumberField
        :model-value="s.maxSlope"
        :step="5"
        :min="L.maxSlope.min"
        :max="L.maxSlope.max"
        title="最大可行走坡度（度）"
        @commit="(v) => emit('update', 'Set Max Slope', clamp(v, L.maxSlope.min, L.maxSlope.max))"
      />
    </div>
    <div class="field">
      <label title="相邻格高差超过此值视为陡坎（不可跨）">Step</label>
      <NumberField
        :model-value="s.maxHeightStep"
        :step="0.25"
        :min="L.maxHeightStep.min"
        :max="L.maxHeightStep.max"
        title="相邻格最大高差（世界单位）"
        @commit="(v) => emit('update', 'Set Max Height Step', clamp(v, L.maxHeightStep.min, L.maxHeightStep.max))"
      />
    </div>
    <div class="field">
      <label title="auto = 收集场景静态碰撞体投影为障碍；ignore = 只按采样源烘焙">Obstacles</label>
      <select
        :value="s.obstaclesMode"
        @change="emit('update', 'Set Obstacles Mode', ($event.target as HTMLSelectElement).value)"
      >
        <option value="auto">自动收集</option>
        <option value="ignore">忽略障碍</option>
      </select>
    </div>

    <!-- ===== Display ===== -->
    <div class="ts-group">Display</div>
    <div class="field">
      <label title="可视化叠层：可行走区域叠加 / SDF 距离场热力图（黄近障碍、蓝远离、障碍内红紫）">Mode</label>
      <select
        :value="s.display"
        @change="emit('update', 'Set Display Mode', ($event.target as HTMLSelectElement).value)"
      >
        <option value="off">关闭</option>
        <option value="walkable">可行走叠加</option>
        <option value="sdf">SDF 热力图</option>
      </select>
    </div>

    <!-- ===== 状态 / 操作 ===== -->
    <div class="ts-actions">
      <button
        :disabled="baking"
        title="按当前设置与场景内容重新烘焙（设置与采样源变化会自动触发）"
        @click="onBake"
      >
        {{ baking ? "烘焙中…" : "重新烘焙" }}
      </button>
      <span v-if="stats" class="hint">
        {{ stats.cells }} 格 · 可行走 {{ (stats.walkableRatio * 100).toFixed(0) }}% ·
        {{ stats.bakeMs.toFixed(1) }}ms
      </span>
      <span v-else class="hint">未烘焙（需要采样源：地形或网格）</span>
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
.ts-actions button:hover:not(:disabled) {
  border-color: var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
.ts-actions button:disabled {
  opacity: 0.45;
  cursor: default;
}
.ts-actions .hint {
  font-size: 10px;
  color: var(--text-dim, #888);
}
</style>
