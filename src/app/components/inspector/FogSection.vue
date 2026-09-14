<script setup lang="ts">
/**
 * 雾节点卡（场景环境雾设置）：
 * - 类型：创建时固定（线性 Fog / 指数 FogExp2 / 高度雾），只读展示；
 * - 颜色：雾色（远处物体向此色过渡；与背景/天空地平线同色时无缝融合）；
 * - 线性雾：Near（起始距离）/ Far（终止距离）；
 * - 指数雾：Density（密度，越大衰减越快）；
 * - 高度雾：Density + Base Height（基准海拔，以下最浓）+ Falloff（向上衰减标度）。
 * 事件统一 emit("update", label, value)，label 即撤销历史文案；
 * 场景中第一个"启用且可见"的雾节点生效（与天空盒同语义）。
 */
import { computed } from "vue";
import type { FogNode } from "../../../framework/prototype/derived/Primitives";
import { FOG_LIMITS, fogKindLabel } from "../../../framework/fog/types";
import NumberField from "../NumberField.vue";

const props = defineProps<{ node: FogNode; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

const L = FOG_LIMITS;

/** 节点是普通类实例（非响应式）：以 rev 为失效信号读取设置 */
const s = computed(() => {
  void props.rev;
  return props.node.fog;
});

const kindLabel = computed(() => fogKindLabel(props.node.fogKind));

function numToHex(v: number): string {
  return "#" + (v & 0xffffff).toString(16).padStart(6, "0");
}
function hexToNum(hex: string): number {
  return parseInt(hex.replace("#", ""), 16) & 0xffffff;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function onColor(e: Event): void {
  emit("update", "Set Fog Color", hexToNum((e.target as HTMLInputElement).value));
}
</script>

<template>
  <div class="fog-section" :data-rev="rev">
    <div class="field">
      <label title="雾类型：创建时由「新建 > 雾」菜单固定，不随序列化切换">类型</label>
      <span class="type-tag">{{ kindLabel }}</span>
      <span class="muted">创建后固定</span>
    </div>
    <div class="field">
      <label title="Color：雾色。远处物体向此色过渡；与背景/天空地平线同色时远处无缝融入">Color</label>
      <input type="color" :value="numToHex(s.color)" @change="onColor" />
    </div>

    <template v-if="props.node.fogKind === 'linear'">
      <div class="field">
        <label title="Near：雾起始距离（相机到物体；此距离内不受雾影响）">Near</label>
        <NumberField
          :model-value="s.near"
          :step="1"
          :min="L.near.min"
          :max="L.near.max"
          title="雾起始距离（世界单位）"
          @commit="(v) => emit('update', 'Set Fog Near', clamp(v, L.near.min, L.near.max))"
        />
      </div>
      <div class="field">
        <label title="Far：雾终止距离（此距离外完全为雾色）">Far</label>
        <NumberField
          :model-value="s.far"
          :step="10"
          :min="L.far.min"
          :max="L.far.max"
          title="雾终止距离（世界单位）"
          @commit="(v) => emit('update', 'Set Fog Far', clamp(v, L.far.min, L.far.max))"
        />
      </div>
    </template>
    <div v-else class="field">
      <label title="Density：指数/高度雾密度。越大随距离衰减越快（典型 0.001~0.1）">Density</label>
      <NumberField
        :model-value="s.density"
        :step="0.005"
        :min="L.density.min"
        :max="L.density.max"
        title="雾密度"
        @commit="(v) => emit('update', 'Set Fog Density', clamp(v, L.density.min, L.density.max))"
      />
    </div>

    <template v-if="props.node.fogKind === 'height'">
      <div class="field">
        <label title="Base Height：基准海拔（世界 Y）。此高度以下雾保持基础浓度，往上逐渐变薄">Base Height</label>
        <NumberField
          :model-value="s.heightY"
          :step="1"
          :min="L.heightY.min"
          :max="L.heightY.max"
          title="基准海拔（世界单位）"
          @commit="(v) => emit('update', 'Set Fog Height', clamp(v, L.heightY.min, L.heightY.max))"
        />
      </div>
      <div class="field">
        <label title="Falloff：衰减标度（世界单位）。雾带中点高出基准面这么多时浓度约剩 1/e；越大向上衰减越缓">Falloff</label>
        <NumberField
          :model-value="s.heightFalloff"
          :step="5"
          :min="L.heightFalloff.min"
          :max="L.heightFalloff.max"
          title="高度衰减标度（世界单位）"
          @commit="(v) => emit('update', 'Set Fog Falloff', clamp(v, L.heightFalloff.min, L.heightFalloff.max))"
        />
      </div>
    </template>

    <div class="hint">
      场景中第一个"启用且可见"的雾节点生效（与天空盒同语义）。线性雾在 Near→Far 间线性过渡到雾色，
      指数雾按相机距离指数衰减（Density 越大越浓），高度雾在此之上按海拔衰减（谷浓山淡，
      Base Height 以下最浓、Falloff 控制向上衰减快慢）。把天空盒地平线色调成雾色，远处物体可与背景无缝融合。
    </div>
  </div>
</template>

<style scoped>
.fog-section .type-tag {
  font-size: 11px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 3px;
  border: 1px solid var(--border, #444);
  color: var(--text, #ddd);
}
</style>
