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
  // 节点是普通类实例（非响应式）：以 rev 为失效信号（灯光类型当前固定，防御性处理）
  void props.rev;
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
/** 可投影灯光：点光（立方体贴图）/ 平行光 / 聚光灯；环境光无阴影 */
const hasShadow = (): boolean =>
  props.node instanceof PointLightNode ||
  props.node instanceof DirectionalLightNode ||
  props.node instanceof SpotLightNode;

/** 可投影灯光（点光/平行光/聚光灯）的阴影配置；环境光返回 null */
function shadowConfig():
  | { castShadow: boolean; strength: number; bias: number; normalBias: number; near: number; radius: number }
  | null {
  if (
    props.node instanceof PointLightNode ||
    props.node instanceof DirectionalLightNode ||
    props.node instanceof SpotLightNode
  ) {
    const s = props.node.shadow;
    return { castShadow: props.node.castShadow, ...s };
  }
  return null;
}

/** Shadow 类型下拉当前档（Off / Hard / Soft，Unity 语义；由投射开关 + 软化半径推导） */
const shadowType = computed<"off" | "hard" | "soft">(() => {
  void props.rev;
  const sc = shadowConfig();
  if (!sc || !sc.castShadow) return "off";
  return sc.radius >= 2 ? "soft" : "hard";
});

function onShadowTypeSelect(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  if (v === "off" || v === "hard" || v === "soft") emit("update", "Set Shadow Type", v);
}

/** 阴影参数当前值（Off 时输入禁用，但仍回显存储值） */
function shadowNum(key: "strength" | "bias" | "normalBias" | "near"): number {
  return shadowConfig()?.[key] ?? 0;
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

  <!-- 点光 / 平行光 / 聚光灯：Shadow 类型下拉（环境光无阴影；Off = 不投影） -->
  <div v-if="hasShadow()" class="field">
    <label title="Shadow Type">Shadow</label>
    <select :value="shadowType" title="Shadow 类型" @change="onShadowTypeSelect">
      <option value="off">Off（无阴影）</option>
      <option value="hard">Hard（硬阴影）</option>
      <option value="soft">Soft（柔和阴影）</option>
    </select>
  </div>

  <!-- 阴影参数组（Unity Light → Shadows 语义；Off 档时禁用输入，仍回显存储值） -->
  <template v-if="hasShadow()">
    <div class="field">
      <label title="阴影浓度：0 = 阴影不可见，1 = 纯黑阴影（Unity Strength）">Strength</label>
      <NumberField
        :model-value="shadowNum('strength')"
        :step="0.05"
        :min="0"
        :max="1"
        :disabled="shadowType === 'off'"
        title="阴影浓度 0~1"
        @commit="(v) => emit('update', 'Set Shadow Strength', clamp(v, 0, 1))"
      />
    </div>
    <div class="field">
      <label title="深度偏移：向远处推可压制自阴影麻点，过负会飘影（Unity Bias）">Bias</label>
      <NumberField
        :model-value="shadowNum('bias')"
        :step="0.0005"
        :min="-0.05"
        :max="0"
        :disabled="shadowType === 'off'"
        title="深度偏移（典型 -0.005 ~ 0）"
        @commit="(v) => emit('update', 'Set Shadow Bias', clamp(v, -0.05, 0))"
      />
    </div>
    <div class="field">
      <label title="沿法线方向偏移阴影采样点；0 = 自动按阴影贴图纹素相对化（Unity Normal Bias）">
        Normal Bias
      </label>
      <NumberField
        :model-value="shadowNum('normalBias')"
        :step="0.005"
        :min="0"
        :disabled="shadowType === 'off'"
        title="法线偏移；0 = 自动"
        @commit="(v) => emit('update', 'Set Shadow NormalBias', Math.max(0, v))"
      />
    </div>
    <div class="field">
      <label title="阴影近裁剪面：比这更近的物体不参与投影（Unity Near Plane）">Near Plane</label>
      <NumberField
        :model-value="shadowNum('near')"
        :step="0.05"
        :min="0.01"
        :disabled="shadowType === 'off'"
        title="阴影近裁剪面（世界单位）"
        @commit="(v) => emit('update', 'Set Shadow Near', Math.max(0.01, v))"
      />
    </div>
  </template>

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
  <template v-if="props.node instanceof SpotLightNode">
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
