<script setup lang="ts">
import { computed } from "vue";
import {
  AmbientLightNode,
  DirectionalLightNode,
  LightNode,
  PointLightNode,
  SpotLightNode,
} from "../../../framework/prototype/derived/Primitives";
import NumberField from "../NumberField.vue";

const props = defineProps<{ node: LightNode; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

const kindLabel = computed(() => {
  const n = props.node;
  if (n instanceof PointLightNode) return "Point Light 点光源";
  if (n instanceof DirectionalLightNode) return "Directional Light 平行光";
  if (n instanceof AmbientLightNode) return "Ambient Light 环境光";
  if (n instanceof SpotLightNode) return "Spot Light 聚光灯";
  return "Light 灯光";
});

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

// —— 各类型参数取值（模板内避免跨属性 instanceof 收窄问题） ——
const isPointOrSpot = (): boolean =>
  props.node instanceof PointLightNode || props.node instanceof SpotLightNode;
const isDirOrSpot = (): boolean =>
  props.node instanceof DirectionalLightNode || props.node instanceof SpotLightNode;
const isSpot = (): boolean => props.node instanceof SpotLightNode;

function shadowEnabled(): boolean {
  const n = props.node;
  if (n instanceof DirectionalLightNode || n instanceof SpotLightNode) return n.castShadow;
  return false;
}
function distanceOf(): number {
  const n = props.node;
  if (n instanceof PointLightNode || n instanceof SpotLightNode) return n.distance;
  return 0;
}
function decayOf(): number {
  const n = props.node;
  if (n instanceof PointLightNode || n instanceof SpotLightNode) return n.decay;
  return 0;
}
function angleOf(): number {
  return props.node instanceof SpotLightNode ? props.node.angle : 0;
}
function penumbraOf(): number {
  return props.node instanceof SpotLightNode ? props.node.penumbra : 0;
}
</script>

<template>
  <div class="light-kind mono" :data-rev="rev">
    <span class="light-kind-tag">{{ kindLabel }}</span>
  </div>

  <div class="field">
    <label>Color</label>
    <input
      type="color"
      :value="numToHex(node.lightColor)"
      @input="(e) => onColorHex((e.target as HTMLInputElement).value)"
      @change="onColorHex(($event.target as HTMLInputElement).value)"
    />
  </div>

  <div class="field">
    <label>Intensity</label>
    <NumberField
      :model-value="node.intensity"
      :step="0.1"
      title="Intensity"
      @commit="(v) => emit('update', 'Set Intensity', v)"
    />
  </div>

  <!-- 平行光 / 聚光灯：阴影开关 -->
  <div v-if="isDirOrSpot()" class="field">
    <label>Shadow</label>
    <input
      type="checkbox"
      :checked="shadowEnabled()"
      @change="emit('update', 'Toggle Shadow', ($event.target as HTMLInputElement).checked)"
    />
  </div>

  <!-- 点光源 / 聚光灯：距离与衰减 -->
  <template v-if="isPointOrSpot()">
    <div class="field">
      <label>Distance</label>
      <NumberField
        :model-value="distanceOf()"
        :step="0.5"
        title="Distance（0 = 无限远）"
        @commit="(v) => emit('update', 'Set Distance', clamp(v, 0, 10000))"
      />
    </div>
    <div class="field">
      <label>Decay</label>
      <NumberField
        :model-value="decayOf()"
        :step="0.1"
        title="Decay（物理衰减指数）"
        @commit="(v) => emit('update', 'Set Decay', clamp(v, 0, 10))"
      />
    </div>
  </template>

  <!-- 聚光灯专属：角度与半影 -->
  <template v-if="isSpot()">
    <div class="field">
      <label>Angle</label>
      <NumberField
        :model-value="angleOf()"
        :step="1"
        title="Angle（光束半角，度）"
        @commit="(v) => emit('update', 'Set Angle', clamp(v, 0.1, 89.9))"
      />
    </div>
    <div class="field">
      <label>Penumbra</label>
      <NumberField
        :model-value="penumbraOf()"
        :step="0.05"
        title="Penumbra（边缘柔和度 0~1）"
        @commit="(v) => emit('update', 'Set Penumbra', clamp(v, 0, 1))"
      />
    </div>
  </template>
</template>
