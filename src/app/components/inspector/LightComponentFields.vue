<script setup lang="ts">
// 灯光组件字段区（组件卡片主体）：类型切换（点光/平行光/聚光灯/环境光）+
// 颜色/强度/阴影/距离/衰减/角度/半影（按类型显隐），光照语义与灯光节点一致。
import { computed } from "vue";
import type { LightComponentRef } from "../../../framework/prototype/Node";
import { LIGHT_KIND_OPTIONS } from "../../lib/component-registry";
import NumberField from "../NumberField.vue";
import CullingMaskField from "../CullingMaskField.vue";

const props = defineProps<{ comp: LightComponentRef }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

const kind = computed(() => props.comp.light.kind);
const isPointOrSpot = computed(() => kind.value === "point" || kind.value === "spot");
/** 可投影灯光：点光（立方体贴图）/ 平行光 / 聚光灯；环境光无阴影 */
const hasShadow = computed(
  () => kind.value === "point" || kind.value === "directional" || kind.value === "spot",
);
const isSpot = computed(() => kind.value === "spot");

/** Shadow 类型下拉当前档（Off / Hard / Soft，由投射开关 + 软化半径推导） */
const shadowType = computed<"off" | "hard" | "soft">(() => {
  if (!props.comp.light.castShadow) return "off";
  return props.comp.light.shadowRadius >= 2 ? "soft" : "hard";
});

function onShadowTypeSelect(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  if (v === "off" || v === "hard" || v === "soft") emit("update", "Set Shadow Type", v);
}

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

/** 分辨率下拉选项（Auto = 按灯型：平面 2048 / 点光 1024） */
const RESOLUTION_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: "Auto（自动）" },
  { value: 512, label: "Low（512）" },
  { value: 1024, label: "Medium（1024）" },
  { value: 2048, label: "High（2048）" },
  { value: 4096, label: "Ultra（4096）" },
];

function onResolutionSelect(e: Event): void {
  const v = parseInt((e.target as HTMLSelectElement).value, 10);
  if (Number.isFinite(v)) emit("update", "Set Shadow Resolution", v);
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

  <!-- Range：照射半径（点光/聚光；0 = 无限远） -->
  <div v-if="isPointOrSpot" class="field">
    <label title="Range：照射距离/作用半径（0 = 无限远）">Range</label>
    <NumberField
      :model-value="comp.light.distance"
      :step="0.5"
      :min="0.01"
      title="照射距离（0 = 无限远；界面最小 0.01，避免拖动归零误入无限远模式）"
      @commit="(v) => emit('update', 'Set Distance', clamp(v, 0.01, 10000))"
    />
  </div>

  <!-- 聚光灯：光束角度与边缘柔和度 -->
  <template v-if="isSpot">
    <div class="field">
      <label title="Spot Angle：光束半角（度；此处为半角，非全角）">Spot Angle</label>
      <NumberField
        :model-value="comp.light.angle"
        :step="1"
        title="光束半角（度，0.1~89.9）"
        @commit="(v) => emit('update', 'Set Angle', clamp(v, 0.1, 89.9))"
      />
    </div>
    <div class="field">
      <label title="Penumbra：光束边缘柔和度 0~1">Penumbra</label>
      <NumberField
        :model-value="comp.light.penumbra"
        :step="0.05"
        title="边缘柔和度 0~1"
        @commit="(v) => emit('update', 'Set Penumbra', clamp(v, 0, 1))"
      />
    </div>
  </template>

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
      :min="0.01"
      title="Intensity（最小 0.01）"
      @commit="(v) => emit('update', 'Set Intensity', Math.max(0.01, v))"
    />
  </div>

  <!-- 点光/聚光：物理衰减指数 -->
  <div v-if="isPointOrSpot" class="field">
    <label title="Decay：物理衰减指数">Decay</label>
    <NumberField
      :model-value="comp.light.decay"
      :step="0.1"
      title="物理衰减指数"
      @commit="(v) => emit('update', 'Set Decay', clamp(v, 0, 10))"
    />
  </div>

  <!-- Culling Mask：只照亮掩码内层的对象 -->
  <div class="field">
    <label title="Culling Mask（只照亮掩码内层的对象；相机 Culling Mask 排除的层本灯也不参与）">
      Culling Mask
    </label>
    <CullingMaskField
      :mask="comp.light.cullingMask"
      @change="(m) => emit('update', 'Set Culling Mask', m)"
    />
  </div>

  <!-- 点光 / 平行光 / 聚光灯：Shadow 类型下拉（环境光无阴影；Off = 不投影） -->
  <div v-if="hasShadow" class="field">
    <label title="Shadow Type">Shadow</label>
    <select :value="shadowType" title="Shadow 类型" @change="onShadowTypeSelect">
      <option value="off">Off（无阴影）</option>
      <option value="hard">Hard（硬阴影）</option>
      <option value="soft">Soft（柔和阴影）</option>
    </select>
  </div>

  <!-- 阴影参数组（Off 档时禁用输入，仍回显存储值） -->
  <template v-if="hasShadow">
    <div class="field">
      <label title="阴影浓度：0 = 阴影不可见，1 = 纯黑阴影">Strength</label>
      <NumberField
        :model-value="comp.light.shadowStrength"
        :step="0.05"
        :min="0"
        :max="1"
        :disabled="shadowType === 'off'"
        title="阴影浓度 0~1"
        @commit="(v) => emit('update', 'Set Shadow Strength', clamp(v, 0, 1))"
      />
    </div>
    <div class="field">
      <label title="深度偏移：向远处推可压制自阴影麻点，过负会飘影">Bias</label>
      <NumberField
        :model-value="comp.light.shadowBias"
        :step="0.0005"
        :min="-0.05"
        :max="0"
        :disabled="shadowType === 'off'"
        title="深度偏移（典型 -0.005 ~ 0）"
        @commit="(v) => emit('update', 'Set Shadow Bias', clamp(v, -0.05, 0))"
      />
    </div>
    <div class="field">
      <label title="沿法线方向偏移阴影采样点；0 = 自动按阴影贴图纹素相对化">
        Normal Bias
      </label>
      <NumberField
        :model-value="comp.light.shadowNormalBias"
        :step="0.005"
        :min="0"
        :disabled="shadowType === 'off'"
        title="法线偏移；0 = 自动"
        @commit="(v) => emit('update', 'Set Shadow NormalBias', Math.max(0, v))"
      />
    </div>
    <div class="field">
      <label title="阴影近裁剪面：比这更近的物体不参与投影">Near Plane</label>
      <NumberField
        :model-value="comp.light.shadowNear"
        :step="0.05"
        :min="0.01"
        :disabled="shadowType === 'off'"
        title="阴影近裁剪面（世界单位）"
        @commit="(v) => emit('update', 'Set Shadow Near', Math.max(0.01, v))"
      />
    </div>
    <div class="field">
      <label title="阴影贴图分辨率：越高边缘越细腻，显存与渲染开销越大（Auto = 平行光/聚光灯 2048、点光 1024）">
        Resolution
      </label>
      <select
        :value="comp.light.shadowResolution"
        :disabled="shadowType === 'off'"
        title="阴影贴图分辨率"
        @change="onResolutionSelect"
      >
        <option
          v-if="!RESOLUTION_OPTIONS.some((o) => o.value === comp.light.shadowResolution)"
          :value="comp.light.shadowResolution"
        >{{ comp.light.shadowResolution }}（未登记档位）</option>
        <option v-for="o in RESOLUTION_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>
  </template>

  <div class="hint">光照方向 = 节点本地 -Z（与灯光/相机朝向约定一致）</div>
</template>
