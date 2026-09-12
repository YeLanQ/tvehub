<script setup lang="ts">
/**
 * UI 2D 变换卡（图片/文本/按钮/布局容器共用）：
 * - 位置：点锚点下「枢轴相对锚点的偏移」（anchoredPosition；显示像素，100px = 1 单位；
 *   布局容器子节点的位置由布局接管，此处改写在布局下不生效）；
 * - 旋转：绕 Z 轴角度（度）；缩放：X/Y（拉伸锚点轴的实际尺寸 = 尺寸 × 父矩形占比）；
 * - 尺寸：设计尺寸 W/H（显示像素；点锚点轴生效，拉伸轴由边距推导）。
 */
import { computed } from "vue";
import { UIWidgetNode, unitsToPx, pxToUnits } from "../../../framework/prototype/derived/Primitives";
import NumberField from "../NumberField.vue";

const props = defineProps<{ node: UIWidgetNode; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

function cur(): UIWidgetNode {
  void props.rev;
  return props.node;
}
const posX = computed(() => unitsToPx(cur().anchoredPosition.x));
const posY = computed(() => unitsToPx(cur().anchoredPosition.y));
const sizeW = computed(() => unitsToPx(cur().size.x));
const sizeH = computed(() => unitsToPx(cur().size.y));
const rotZ = computed(() => cur().transform.rotation.z);
const scaleX = computed(() => cur().transform.scale.x);
const scaleY = computed(() => cur().transform.scale.y);
const sortOrder = computed(() => cur().sortOrder);

const emitUnits = (label: string, px: number): void => emit("update", label, pxToUnits(px));
</script>

<template>
  <div class="ui-section" :data-rev="rev">
    <div class="field-row">
      <div class="field">
        <label title="锚点位置 X（像素；点锚点下枢轴相对锚点的偏移）">位置 X</label>
        <NumberField :model-value="posX" :step="10" title="锚点位置 X（100px = 1 单位）" @commit="(v) => emitUnits('anchoredPosition.x', v)" />
      </div>
      <div class="field">
        <label title="锚点位置 Y（像素；向上为正）">位置 Y</label>
        <NumberField :model-value="posY" :step="10" title="锚点位置 Y（100px = 1 单位，向上为正）" @commit="(v) => emitUnits('anchoredPosition.y', v)" />
      </div>
    </div>
    <div class="field-row">
      <div class="field">
        <label title="尺寸 W（像素；点锚点轴生效）">尺寸 W</label>
        <NumberField :model-value="sizeW" :step="10" :min="1" title="设计尺寸 W（100px = 1 单位；拉伸轴由边距推导）" @commit="(v) => emitUnits('size.x', v)" />
      </div>
      <div class="field">
        <label title="尺寸 H（像素；点锚点轴生效）">尺寸 H</label>
        <NumberField :model-value="sizeH" :step="10" :min="1" title="设计尺寸 H（100px = 1 单位；拉伸轴由边距推导）" @commit="(v) => emitUnits('size.y', v)" />
      </div>
    </div>
    <div class="field">
      <label title="旋转（度，绕 Z 轴）">旋转</label>
      <NumberField :model-value="rotZ" :step="5" title="绕 Z 轴旋转角度（度）" @commit="(v) => emit('update', 'rotZ', v)" />
    </div>
    <div class="field-row">
      <div class="field">
        <label title="缩放 X">缩放 X</label>
        <NumberField :model-value="scaleX" :step="0.1" :min="0.01" title="2D 缩放 X" @commit="(v) => emit('update', 'scale.x', v)" />
      </div>
      <div class="field">
        <label title="缩放 Y">缩放 Y</label>
        <NumberField :model-value="scaleY" :step="0.1" :min="0.01" title="2D 缩放 Y" @commit="(v) => emit('update', 'scale.y', v)" />
      </div>
    </div>
    <div class="field">
      <label title="Sort Order（同画布内大者在上；点击命中也按此取最上层）">Sort Order</label>
      <NumberField :model-value="sortOrder" :step="1" :min="-999" :max="999" title="画布内叠加序（大者在上）" @commit="(v) => emit('update', 'sortOrder', v)" />
    </div>
    <div class="hint">位置/尺寸按 100px = 1 单位换算；拉伸锚点轴的位置/尺寸由父矩形与边距推导</div>
  </div>
</template>
