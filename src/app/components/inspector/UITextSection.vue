<script setup lang="ts">
/**
 * UI 文本（Text）Widget 卡片：内容（多行）、字号（1080p 参考分辨率像素）、
 * 颜色/加粗/斜体、字族、水平对齐、矩形尺寸与画布内 Sort Order。
 */
import { computed } from "vue";
import { UITextNode } from "../../../framework/prototype/derived/Primitives";
import NumberField from "../NumberField.vue";

const props = defineProps<{ node: UITextNode; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

const FONT_FAMILY_OPTIONS = [
  { value: "system", label: "System（系统无衬线）" },
  { value: "serif", label: "Serif（衬线）" },
  { value: "mono", label: "Mono（等宽）" },
];
const ALIGN_OPTIONS = [
  { value: "left", label: "左对齐" },
  { value: "center", label: "居中" },
  { value: "right", label: "右对齐" },
];

/** 以下全部以 rev 为失效信号（节点是普通类实例，非响应式） */
const text = computed(() => {
  void props.rev;
  return props.node.text;
});
const fontSize = computed(() => {
  void props.rev;
  return props.node.fontSize;
});
const color = computed(() => {
  void props.rev;
  return "#" + (props.node.color & 0xffffff).toString(16).padStart(6, "0");
});
const sizeX = computed(() => {
  void props.rev;
  return props.node.size.x;
});
const sizeY = computed(() => {
  void props.rev;
  return props.node.size.y;
});
const sortOrder = computed(() => {
  void props.rev;
  return props.node.sortOrder;
});

function onTextInput(e: Event): void {
  emit("update", "text", (e.target as HTMLTextAreaElement).value);
}
function onColorInput(e: Event): void {
  const v = parseInt((e.target as HTMLInputElement).value.replace("#", ""), 16);
  if (!Number.isNaN(v)) emit("update", "color", v & 0xffffff);
}
function onSelect(label: string) {
  return (e: Event): void => {
    emit("update", label, (e.target as HTMLSelectElement).value);
  };
}
function onBoldChange(e: Event): void {
  emit("update", "bold", (e.target as HTMLInputElement).checked);
}
function onItalicChange(e: Event): void {
  emit("update", "italic", (e.target as HTMLInputElement).checked);
}
</script>

<template>
  <div class="ui-section" :data-rev="rev">
    <div class="field field-top">
      <label title="Text（支持多行）">内容</label>
      <textarea
        :value="text"
        rows="3"
        title="文本内容（支持换行，超界自动换行裁剪）"
        @change="onTextInput"
      />
    </div>
    <div class="field">
      <label title="Font Size（1080p 参考分辨率下的像素字号）">字号</label>
      <NumberField :model-value="fontSize" :step="1" :min="4" :max="512" title="字号（1080p 参考像素）" @commit="(v) => emit('update', 'fontSize', v)" />
    </div>
    <div class="field">
      <label title="Color">颜色</label>
      <input type="color" :value="color" @input="onColorInput" @change="onColorInput" />
    </div>
    <div class="field">
      <label title="Font Family">字族</label>
      <select :value="node.fontFamily" @change="onSelect('fontFamily')">
        <option v-for="o in FONT_FAMILY_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>
    <div class="field">
      <label title="Alignment">对齐</label>
      <select :value="node.align" @change="onSelect('align')">
        <option v-for="o in ALIGN_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>
    <div class="field">
      <label>样式</label>
      <label class="check"><input type="checkbox" :checked="node.bold" @change="onBoldChange" /> 加粗</label>
      <label class="check"><input type="checkbox" :checked="node.italic" @change="onItalicChange" /> 斜体</label>
    </div>
    <div class="field">
      <label title="Size（文本框尺寸，UI 单位）">框宽</label>
      <NumberField :model-value="sizeX" :step="0.1" :min="0.01" title="文本框宽（UI 单位）" @commit="(v) => emit('update', 'size.x', v)" />
    </div>
    <div class="field">
      <label>框高</label>
      <NumberField :model-value="sizeY" :step="0.1" :min="0.01" title="文本框高（UI 单位）" @commit="(v) => emit('update', 'size.y', v)" />
    </div>
    <div class="field">
      <label title="Sort Order（同画布内大者在上）">Sort Order</label>
      <NumberField :model-value="sortOrder" :step="1" :min="-999" :max="999" title="画布内叠加序（大者在上）" @commit="(v) => emit('update', 'sortOrder', v)" />
    </div>
  </div>
</template>

<style scoped>
.field-top textarea {
  width: 100%;
  resize: vertical;
}
.check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-right: 10px;
  white-space: nowrap;
}
</style>
