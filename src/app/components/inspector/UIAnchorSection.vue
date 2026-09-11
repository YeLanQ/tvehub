<script setup lang="ts">
/**
 * UI 锚点卡（图片/文本/按钮/布局容器共用）：
 * - 锚点预设：常用九宫格锚点与拉伸组合一键设置（保偏移）；
 * - anchorMin/anchorMax：父矩形上的归一化锚点（0..1；某轴 min==max 为点锚点，
 *   min<max 为拉伸——该轴尺寸由父矩形与边距推导，避免屏幕适配时布局错位）；
 * - pivot：Widget 自身归一化枢轴；offsetMin/Max：拉伸轴边距（显示像素）。
 */
import { computed } from "vue";
import { UIWidgetNode, pxToUnits, unitsToPx } from "../../../framework/prototype/derived/Primitives";
import NumberField from "../NumberField.vue";

const props = defineProps<{ node: UIWidgetNode; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

function cur(): UIWidgetNode {
  void props.rev;
  return props.node;
}

/** 锚点预设（保偏移）：min/max 同时写（label, min{0,1}, max{0,1}） */
const PRESETS: { value: string; label: string; min: [number, number]; max: [number, number] }[] = [
  { value: "center", label: "居中", min: [0.5, 0.5], max: [0.5, 0.5] },
  { value: "top-left", label: "左上", min: [0, 1], max: [0, 1] },
  { value: "top", label: "中上", min: [0.5, 1], max: [0.5, 1] },
  { value: "top-right", label: "右上", min: [1, 1], max: [1, 1] },
  { value: "left", label: "左中", min: [0, 0.5], max: [0, 0.5] },
  { value: "right", label: "右中", min: [1, 0.5], max: [1, 0.5] },
  { value: "bottom-left", label: "左下", min: [0, 0], max: [0, 0] },
  { value: "bottom", label: "中下", min: [0.5, 0], max: [0.5, 0] },
  { value: "bottom-right", label: "右下", min: [1, 0], max: [1, 0] },
  { value: "stretch-h", label: "横向拉伸", min: [0, 0.5], max: [1, 0.5] },
  { value: "stretch-v", label: "纵向拉伸", min: [0.5, 0], max: [0.5, 1] },
  { value: "stretch", label: "双向拉伸", min: [0, 0], max: [1, 1] },
];

const presetValue = computed(() => {
  const n = cur();
  const hit = PRESETS.find(
    (p) =>
      Math.abs(p.min[0] - n.anchorMin.x) < 1e-4 &&
      Math.abs(p.min[1] - n.anchorMin.y) < 1e-4 &&
      Math.abs(p.max[0] - n.anchorMax.x) < 1e-4 &&
      Math.abs(p.max[1] - n.anchorMax.y) < 1e-4,
  );
  return hit?.value ?? "";
});

function onPreset(e: Event): void {
  const p = PRESETS.find((x) => x.value === (e.target as HTMLSelectElement).value);
  if (!p) return;
  emit("update", "anchorMin", { x: p.min[0], y: p.min[1] });
  emit("update", "anchorMax", { x: p.max[0], y: p.max[1] });
}

const num = (path: "anchorMin" | "anchorMax" | "pivot", axis: "x" | "y") =>
  computed(() => cur()[path][axis]);
const anchorMinX = num("anchorMin", "x");
const anchorMinY = num("anchorMin", "y");
const anchorMaxX = num("anchorMax", "x");
const anchorMaxY = num("anchorMax", "y");
const pivotX = num("pivot", "x");
const pivotY = num("pivot", "y");
const offsetL = computed(() => unitsToPx(cur().offsetMin.x));
const offsetB = computed(() => unitsToPx(cur().offsetMin.y));
const offsetR = computed(() => unitsToPx(cur().offsetMax.x));
const offsetT = computed(() => unitsToPx(cur().offsetMax.y));
</script>

<template>
  <div class="ui-section" :data-rev="rev">
    <div class="field">
      <label for="ui-anchor-preset" title="锚点预设（保持当前偏移，只改锚点位置）">锚点预设</label>
      <select id="ui-anchor-preset" :value="presetValue" @change="onPreset">
        <option v-for="p in PRESETS" :key="p.value" :value="p.value">{{ p.label }}</option>
        <option value="" disabled>自定义</option>
      </select>
    </div>
    <div class="field-row">
      <div class="field">
        <label title="锚点下限 X（父矩形归一化 0..1）">锚点 Min X</label>
        <NumberField :model-value="anchorMinX" :step="0.05" :min="0" :max="1" title="父矩形归一化锚点（0=左/下，1=右/上）" @commit="(v) => emit('update', 'anchorMin.x', v)" />
      </div>
      <div class="field">
        <label title="锚点下限 Y（父矩形归一化 0..1，向上为正）">锚点 Min Y</label>
        <NumberField :model-value="anchorMinY" :step="0.05" :min="0" :max="1" title="父矩形归一化锚点（0=左/下，1=右/上）" @commit="(v) => emit('update', 'anchorMin.y', v)" />
      </div>
    </div>
    <div class="field-row">
      <div class="field">
        <label title="锚点上限 X（大于 Min X 时该轴拉伸）">锚点 Max X</label>
        <NumberField :model-value="anchorMaxX" :step="0.05" :min="0" :max="1" title="大于 Min X 时该轴为拉伸锚点（尺寸随父矩形）" @commit="(v) => emit('update', 'anchorMax.x', v)" />
      </div>
      <div class="field">
        <label title="锚点上限 Y（大于 Min Y 时该轴拉伸）">锚点 Max Y</label>
        <NumberField :model-value="anchorMaxY" :step="0.05" :min="0" :max="1" title="大于 Min Y 时该轴为拉伸锚点（尺寸随父矩形）" @commit="(v) => emit('update', 'anchorMax.y', v)" />
      </div>
    </div>
    <div class="field-row">
      <div class="field">
        <label title="枢轴 X（Widget 自身归一化 0..1）">枢轴 X</label>
        <NumberField :model-value="pivotX" :step="0.05" :min="0" :max="1" title="Widget 归一化枢轴（点锚点定位与旋转基准）" @commit="(v) => emit('update', 'pivot.x', v)" />
      </div>
      <div class="field">
        <label title="枢轴 Y（Widget 自身归一化 0..1）">枢轴 Y</label>
        <NumberField :model-value="pivotY" :step="0.05" :min="0" :max="1" title="Widget 归一化枢轴（点锚点定位与旋转基准）" @commit="(v) => emit('update', 'pivot.y', v)" />
      </div>
    </div>
    <div class="field-row">
      <div class="field">
        <label title="左边距（像素；拉伸轴相对左/下锚线的边距）">边距 左</label>
        <NumberField :model-value="offsetL" :step="10" title="左/下边距（拉伸轴生效）" @commit="(v) => emit('update', 'offsetMin.x', pxToUnits(v))" />
      </div>
      <div class="field">
        <label title="下边距（像素；拉伸轴相对左/下锚线的边距）">边距 下</label>
        <NumberField :model-value="offsetB" :step="10" title="左/下边距（拉伸轴生效）" @commit="(v) => emit('update', 'offsetMin.y', pxToUnits(v))" />
      </div>
    </div>
    <div class="field-row">
      <div class="field">
        <label title="右边距（像素；拉伸轴相对右/上锚线的边距）">边距 右</label>
        <NumberField :model-value="offsetR" :step="10" title="右/上边距（拉伸轴生效）" @commit="(v) => emit('update', 'offsetMax.x', pxToUnits(v))" />
      </div>
      <div class="field">
        <label title="上边距（像素；拉伸轴相对右/上锚线的边距）">边距 上</label>
        <NumberField :model-value="offsetT" :step="10" title="右/上边距（拉伸轴生效）" @commit="(v) => emit('update', 'offsetMax.y', pxToUnits(v))" />
      </div>
    </div>
    <div class="hint">拉伸锚点：该轴尺寸由父矩形与边距推导，屏幕适配时随父矩形缩放不跑位</div>
  </div>
</template>
