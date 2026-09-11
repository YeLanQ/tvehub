<script setup lang="ts">
/**
 * UI 图片（Image）Widget 卡片：图片资产绑定（内置/项目图片下拉）、着色、
 * 矩形尺寸与画布内 Sort Order（叠加顺序，大者在上）。
 */
import { computed } from "vue";
import { isInternalAsset } from "../../../lib/internal-assets";
import { getAssetsStore } from "../../stores/assets";
import { UIImageNode } from "../../../framework/prototype/derived/Primitives";
import NumberField from "../NumberField.vue";

const props = defineProps<{ node: UIImageNode; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

const assetsStore = getAssetsStore();

// —— 图片资产下拉：内置 + 项目图片资产（png/jpg/webp/gif…；空 = 纯色矩形）——
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

function onImageSelect(e: Event): void {
  emit("update", "image", (e.target as HTMLSelectElement).value);
}
function onColorInput(e: Event): void {
  const v = parseInt((e.target as HTMLInputElement).value.replace("#", ""), 16);
  if (!Number.isNaN(v)) emit("update", "color", v & 0xffffff);
}
</script>

<template>
  <div class="ui-section" :data-rev="rev">
    <div class="field">
      <label title="Source Image（空 = 纯色矩形）">图片</label>
      <select :value="image" title="图片资产（空 = 纯色矩形）" @change="onImageSelect">
        <option value="">（无）</option>
        <optgroup v-if="imageOptions.internal.length" label="内置图片">
          <option v-for="o in imageOptions.internal" :key="o.rel" :value="o.rel">{{ o.name }}</option>
        </optgroup>
        <optgroup v-if="imageOptions.project.length" label="项目图片">
          <option v-for="o in imageOptions.project" :key="o.rel" :value="o.rel">{{ o.name }}</option>
        </optgroup>
        <option v-if="image && !imageOptions.internal.some((o) => o.rel === image) && !imageOptions.project.some((o) => o.rel === image)" :value="image" disabled>
          {{ image }}（未列出）
        </option>
      </select>
    </div>
    <div class="field">
      <label title="Color（与图片相乘；无图片时即底色）">颜色</label>
      <input type="color" :value="color" title="着色（与图片相乘）" @input="onColorInput" @change="onColorInput" />
    </div>
    <div class="field">
      <label title="Size（UI 单位）">尺寸 X</label>
      <NumberField :model-value="sizeX" :step="0.1" :min="0.01" title="矩形宽（UI 单位）" @commit="(v) => emit('update', 'size.x', v)" />
    </div>
    <div class="field">
      <label>尺寸 Y</label>
      <NumberField :model-value="sizeY" :step="0.1" :min="0.01" title="矩形高（UI 单位）" @commit="(v) => emit('update', 'size.y', v)" />
    </div>
    <div class="field">
      <label title="Sort Order（同画布内大者在上）">Sort Order</label>
      <NumberField :model-value="sortOrder" :step="1" :min="-999" :max="999" title="画布内叠加序（大者在上）" @commit="(v) => emit('update', 'sortOrder', v)" />
    </div>
  </div>
</template>
