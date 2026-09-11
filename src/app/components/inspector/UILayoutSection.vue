<script setup lang="ts">
/**
 * UI 布局容器卡（Layout Group）：
 * - 排列模式：none 不排列（纯容器）/ horizontal 横向一行 / vertical 竖向一列 /
 *   grid 网格（列数固定，行数由子元素数量推导）；
 * - 内边距/间距（像素）：内容区 = 容器矩形收进四边；子元素在槽位/格子内居中。
 * 子元素位置由布局接管（anchoredPosition 不生效）；排列顺序 = 层级子节点顺序。
 */
import { computed } from "vue";
import { UILayoutNode, pxToUnits, unitsToPx } from "../../../framework/prototype/derived/Primitives";
import NumberField from "../NumberField.vue";

const props = defineProps<{ node: UILayoutNode; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

const MODES: { value: string; label: string; title: string }[] = [
  { value: "none", label: "无", title: "不排列（子节点走锚点定位）" },
  { value: "horizontal", label: "横向", title: "子元素从左往右排一行，垂直居中" },
  { value: "vertical", label: "竖向", title: "子元素从上往下排一列，水平居中" },
  { value: "grid", label: "网格", title: "按列数网格排列（格子取子元素最大宽高）" },
];

function cur(): UILayoutNode {
  void props.rev;
  return props.node;
}
const padL = computed(() => unitsToPx(cur().padding.left));
const padR = computed(() => unitsToPx(cur().padding.right));
const padT = computed(() => unitsToPx(cur().padding.top));
const padB = computed(() => unitsToPx(cur().padding.bottom));
const spX = computed(() => unitsToPx(cur().spacing.x));
const spY = computed(() => unitsToPx(cur().spacing.y));
const cols = computed(() => cur().gridColumns);

function onMode(e: Event): void {
  emit("update", "layoutMode", (e.target as HTMLSelectElement).value);
}
const emitPad = (label: string, px: number): void => emit("update", label, pxToUnits(px));
const emitSp = (label: string, px: number): void => emit("update", label, pxToUnits(px));
</script>

<template>
  <div class="ui-section" :data-rev="rev">
    <div class="field">
      <label for="ui-layout-mode" title="排列模式">排列模式</label>
      <select id="ui-layout-mode" :value="node.layoutMode" @change="onMode">
        <option v-for="m in MODES" :key="m.value" :value="m.value" :title="m.title">{{ m.label }}</option>
      </select>
    </div>
    <template v-if="node.layoutMode !== 'none'">
      <div class="field-row">
        <div class="field">
          <label title="内边距 左（像素）">内边距 左</label>
          <NumberField :model-value="padL" :step="10" :min="0" title="内容区左内边距" @commit="(v) => emitPad('padding.left', v)" />
        </div>
        <div class="field">
          <label title="内边距 右（像素）">内边距 右</label>
          <NumberField :model-value="padR" :step="10" :min="0" title="内容区右内边距" @commit="(v) => emitPad('padding.right', v)" />
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label title="内边距 上（像素）">内边距 上</label>
          <NumberField :model-value="padT" :step="10" :min="0" title="内容区上内边距" @commit="(v) => emitPad('padding.top', v)" />
        </div>
        <div class="field">
          <label title="内边距 下（像素）">内边距 下</label>
          <NumberField :model-value="padB" :step="10" :min="0" title="内容区下内边距" @commit="(v) => emitPad('padding.bottom', v)" />
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label title="子元素横向间距（像素）">间距 X</label>
          <NumberField :model-value="spX" :step="10" :min="0" title="子元素横向间距" @commit="(v) => emitSp('spacing.x', v)" />
        </div>
        <div class="field">
          <label title="子元素纵向间距（像素）">间距 Y</label>
          <NumberField :model-value="spY" :step="10" :min="0" title="子元素纵向间距" @commit="(v) => emitSp('spacing.y', v)" />
        </div>
      </div>
      <div v-if="node.layoutMode === 'grid'" class="field">
        <label title="网格列数（行数由子元素数量推导）">列数</label>
        <NumberField :model-value="cols" :step="1" :min="1" title="网格列数" @commit="(v) => emit('update', 'gridColumns', Math.max(1, Math.round(v)))" />
      </div>
      <div class="hint">子元素位置由布局接管（排列顺序 = 层级顺序；子元素在槽位内居中）</div>
    </template>
  </div>
</template>
