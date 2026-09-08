<script setup lang="ts">
// 灯光组件字段区（组件卡片主体）：类型切换（点光/平行光/聚光灯/环境光）+
// 颜色/强度/阴影/距离/衰减/角度/半影（按类型显隐），光照语义与灯光节点一致。
import { computed } from "vue";
import type { LightComponentRef } from "../../../framework/prototype/Node";
import { LIGHT_KIND_OPTIONS } from "../../lib/component-registry";
import NumberField from "../NumberField.vue";

const props = defineProps<{ comp: LightComponentRef }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

const kind = computed(() => props.comp.light.kind);
const isPointOrSpot = computed(() => kind.value === "point" || kind.value === "spot");
const isDirOrSpot = computed(() => kind.value === "directional" || kind.value === "spot");
const isSpot = computed(() => kind.value === "spot");

function numToHex(v: number): string {
  return "#" + (v & 0xffffff).toString(16).padStart(6, "0");
}

function onColorHex(hex: string): void {
  const v = parseInt(hex.replace("#", ""), 16);
  if (Number.isNaN(v)) return;
  emit("update", "Set Color", v);
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
</script>

<template>
  <div class="field">
    <label>类型</label>
    <select
      :value="comp.light.kind"
      @change="emit('update', 'Set Light Kind', ($event.target as HTMLSelectElement).value)"
    >
      <option v-for="k in LIGHT_KIND_OPTIONS" :key="k.value" :value="k.value">{{ k.label }}</option>
    </select>
  </div>

  <div class="field">
    <label>Color</label>
    <input
      type="color"
      :value="numToHex(comp.light.lightColor)"
      @input="(e) => onColorHex((e.target as HTMLInputElement).value)"
      @change="onColorHex(($event.target as HTMLInputElement).value)"
    />
  </div>

  <div class="field">
    <label>Intensity</label>
    <NumberField
      :model-value="comp.light.intensity"
      :step="0.1"
      title="Intensity"
      @commit="(v) => emit('update', 'Set Intensity', Math.max(0, v))"
    />
  </div>

  <!-- 平行光 / 聚光灯：阴影开关 -->
  <div v-if="isDirOrSpot" class="field">
    <label>Shadow</label>
    <input
      type="checkbox"
      :checked="comp.light.castShadow"
      @change="emit('update', 'Toggle Shadow', ($event.target as HTMLInputElement).checked)"
    />
  </div>

  <!-- 点光源 / 聚光灯：距离与衰减 -->
  <template v-if="isPointOrSpot">
    <div class="field">
      <label>Distance</label>
      <NumberField
        :model-value="comp.light.distance"
        :step="0.5"
        title="Distance（0 = 无限远）"
        @commit="(v) => emit('update', 'Set Distance', clamp(v, 0, 10000))"
      />
    </div>
    <div class="field">
      <label>Decay</label>
      <NumberField
        :model-value="comp.light.decay"
        :step="0.1"
        title="Decay（物理衰减指数）"
        @commit="(v) => emit('update', 'Set Decay', clamp(v, 0, 10))"
      />
    </div>
  </template>

  <!-- 聚光灯专属：角度与半影 -->
  <template v-if="isSpot">
    <div class="field">
      <label>Angle</label>
      <NumberField
        :model-value="comp.light.angle"
        :step="1"
        title="Angle（光束半角，度）"
        @commit="(v) => emit('update', 'Set Angle', clamp(v, 0.1, 89.9))"
      />
    </div>
    <div class="field">
      <label>Penumbra</label>
      <NumberField
        :model-value="comp.light.penumbra"
        :step="0.05"
        title="Penumbra（边缘柔和度 0~1）"
        @commit="(v) => emit('update', 'Set Penumbra', clamp(v, 0, 1))"
      />
    </div>
  </template>

  <div class="hint">光照方向 = 节点本地 -Z（与灯光/相机朝向约定一致）</div>
</template>
