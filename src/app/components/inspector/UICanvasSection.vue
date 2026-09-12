<script setup lang="ts">
/**
 * UI 画布（UI Canvas）卡片 —— Canvas-Widget 的 Canvas 容器：
 * - 渲染模式：屏幕叠加（相机叠加；画布空间每帧贴合活动渲染相机）；
 * - 渲染尺寸：设计分辨率（设计像素；100px = 1 UI 单位，默认取项目设置）；
 * - 缩放模式：画布矩形映射到屏幕的适配方案（与项目设置同语义）；
 * - Sort Order：画布整体排序（多画布叠加时大者在上，优先于画布内 Widget 排序）。
 */
import { computed } from "vue";
import { UICanvasNode } from "../../../framework/prototype/derived/Primitives";
import NumberField from "../NumberField.vue";

const props = defineProps<{ node: UICanvasNode; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

const SCALE_MODES: { value: string; label: string; title: string }[] = [
  { value: "noscale", label: "不缩放", title: "按设计分辨率原尺寸显示（可能超出或不满屏）" },
  { value: "fixedwidth", label: "固定宽度", title: "宽度铺满屏幕，高度按设计比例（等比）" },
  { value: "fixedheight", label: "固定高度", title: "高度铺满屏幕，宽度按设计比例（等比）" },
  { value: "fixedauto", label: "等比铺满", title: "保持设计比例占满屏幕（超出部分居中裁切）" },
  { value: "full", label: "全屏拉伸", title: "拉伸铺满屏幕（不保持比例）" },
];
// 缩放模式仅预览/构建产物运行时生效；编辑器布局视图恒按设计尺寸 1:1 显示

/** 以 rev 为失效信号（节点是普通类实例，非响应式） */
const sortOrder = computed(() => {
  void props.rev;
  return props.node.sortOrder;
});
const designWidth = computed(() => {
  void props.rev;
  return props.node.designWidth;
});
const designHeight = computed(() => {
  void props.rev;
  return props.node.designHeight;
});

function onSortOrderCommit(v: number): void {
  if (v !== props.node.sortOrder) emit("update", "sortOrder", v);
}
function onDesignWidthCommit(v: number): void {
  if (v !== props.node.designWidth) emit("update", "designWidth", v);
}
function onDesignHeightCommit(v: number): void {
  if (v !== props.node.designHeight) emit("update", "designHeight", v);
}
function onScaleModeChange(e: Event): void {
  emit("update", "scaleMode", (e.target as HTMLSelectElement).value);
}
</script>

<template>
  <div class="ui-section" :data-rev="rev">
    <div class="field">
      <label title="Render Mode">渲染模式</label>
      <select :value="node.renderMode" disabled title="当前仅支持屏幕叠加（相机叠加渲染）">
        <option value="overlay">屏幕叠加（Overlay）</option>
      </select>
    </div>
    <div class="field">
      <label title="设计宽度（设计像素；100px = 1 UI 单位）">设计宽度</label>
      <NumberField
        :model-value="designWidth"
        :step="10"
        :min="1"
        :max="16384"
        title="画布设计宽度（设计像素；100px = 1 UI 单位）"
        @commit="onDesignWidthCommit"
      />
    </div>
    <div class="field">
      <label title="设计高度（设计像素；100px = 1 UI 单位）">设计高度</label>
      <NumberField
        :model-value="designHeight"
        :step="10"
        :min="1"
        :max="16384"
        title="画布设计高度（设计像素；100px = 1 UI 单位）"
        @commit="onDesignHeightCommit"
      />
    </div>
    <div class="field">
      <label for="ui-canvas-scale" title="屏幕适配（仅预览/构建产物运行时生效；布局视图恒按设计尺寸 1:1 显示）">缩放模式</label>
      <select id="ui-canvas-scale" :value="node.scaleMode" @change="onScaleModeChange">
        <option v-for="m in SCALE_MODES" :key="m.value" :value="m.value" :title="m.title">{{ m.label }}</option>
      </select>
    </div>
    <div class="field">
      <label title="Sort Order（多画布叠加时大者在上）">Sort Order</label>
      <NumberField
        :model-value="sortOrder"
        :step="1"
        :min="-500"
        :max="500"
        title="画布整体排序（多画布叠加时大者在上）"
        @commit="onSortOrderCommit"
      />
    </div>
    <div class="hint" title="子节点经锚点相对画布矩形定位；2D 变换按 100px = 1 单位换算">
      子节点经锚点相对画布矩形定位（1 单位 = 100px）
    </div>
  </div>
</template>
