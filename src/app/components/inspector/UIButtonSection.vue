<script setup lang="ts">
/**
 * UI 按钮（Button）Widget 卡片：背景（图片/纯色）、标签样式、可交互开关。
 * 位置/尺寸/排序在 2D Transform 与 Anchor 卡。运行时点击经 engine.ui.onClick 订阅。
 */
import { computed } from "vue";
import { isInternalAsset } from "../../../lib/internal-assets";
import { getAssetsStore } from "../../stores/assets";
import { UIButtonNode } from "../../../framework/prototype/derived/Primitives";
import NumberField from "../NumberField.vue";

const props = defineProps<{ node: UIButtonNode; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

const assetsStore = getAssetsStore();

// —— 背景图片下拉：内置 + 项目图片资产（空 = 纯色背景）——
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "tga", "svg"]);
const imageOptions = computed(() => {
  void props.rev;
  const internal: { rel: string; name: string }[] = [];
  const project: { rel: string; name: string }[] = [];
  for (const a of assetsStore.assets) {
    if (!IMAGE_EXTS.has(a.kind)) continue;
    if (isInternalAsset(a.path)) internal.push({ rel: a.path, name: a.name });
    else if (a.path.startsWith("assets/")) project.push({ rel: a.path, name: a.name });
  }
  return { internal, project };
});

const image = computed(() => {
  void props.rev;
  return props.node.image;
});
const color = computed(() => {
  void props.rev;
  return "#" + (props.node.color & 0xffffff).toString(16).padStart(6, "0");
});
const labelColor = computed(() => {
  void props.rev;
  return "#" + (props.node.labelColor & 0xffffff).toString(16).padStart(6, "0");
});

function onImageSelect(e: Event): void {
  emit("update", "image", (e.target as HTMLSelectElement).value);
}
function onColorInput(label: string, e: Event): void {
  const v = parseInt((e.target as HTMLInputElement).value.replace("#", ""), 16);
  if (!Number.isNaN(v)) emit("update", label, v & 0xffffff);
}
function onLabelInput(e: Event): void {
  emit("update", "label", (e.target as HTMLInputElement).value);
}
function onInteractableChange(e: Event): void {
  emit("update", "interactable", (e.target as HTMLInputElement).checked);
}
</script>

<template>
  <div class="ui-section" :data-rev="rev">
    <div class="field">
      <label title="Background Image（空 = 纯色背景）">背景图</label>
      <select :value="image" title="背景图片资产（空 = 纯色背景）" @change="onImageSelect">
        <option value="">（无）</option>
        <optgroup v-if="imageOptions.internal.length" label="内置图片">
          <option v-for="o in imageOptions.internal" :key="o.rel" :value="o.rel">{{ o.name }}</option>
        </optgroup>
        <optgroup v-if="imageOptions.project.length" label="项目图片">
          <option v-for="o in imageOptions.project" :key="o.rel" :value="o.rel">{{ o.name }}</option>
        </optgroup>
      </select>
    </div>
    <div class="field">
      <label title="Color（背景着色）">背景色</label>
      <input type="color" :value="color" @input="onColorInput('color', $event)" @change="onColorInput('color', $event)" />
    </div>
    <div class="field">
      <label title="Label">标签</label>
      <input type="text" :value="node.label" @change="onLabelInput" />
    </div>
    <div class="field">
      <label title="Label Color">标签色</label>
      <input type="color" :value="labelColor" @input="onColorInput('labelColor', $event)" @change="onColorInput('labelColor', $event)" />
    </div>
    <div class="field">
      <label title="Font Size（设计像素；100px = 1 单位）">标签字号</label>
      <NumberField :model-value="node.fontSize" :step="1" :min="4" :max="512" title="标签字号（设计像素，100px = 1 单位）" @commit="(v) => emit('update', 'fontSize', v)" />
    </div>
    <div class="field">
      <label>样式</label>
      <label class="check"><input type="checkbox" :checked="node.labelBold" @change="(e) => emit('update', 'labelBold', (e.target as HTMLInputElement).checked)" /> 加粗</label>
      <label class="check"><input type="checkbox" :checked="node.interactable" @change="onInteractableChange" /> 可点击</label>
    </div>
    <div class="hint">位置/尺寸/排序在「2D Transform」与「Anchor」卡编辑（100px = 1 单位）</div>
  </div>
</template>

<style scoped>
.check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-right: 10px;
  white-space: nowrap;
}
</style>
