<script setup lang="ts">
/**
 * 材质参数编辑器（数据驱动，按 MaterialParamGroup[] 渲染全部暴露参数）：
 * 从 MaterialSection 抽出共享——节点材质卡片与资产检查器的材质编辑共用同一份实现。
 * props.local 为展示镜像（调用方持有并在编辑时被就地更新），disabled 统一控制只读。
 */
import { computed } from "vue";
import {
  colorToHexString,
  materialParamMax,
  parseColorHex,
  type MaterialEnableKey,
  type MaterialParamDef,
  type MaterialParamGroup,
  type MaterialParamKey,
} from "../../../framework/material";
import { isInternalAsset } from "../../../lib/internal-assets";
import { getAssetsStore } from "../../stores/assets";
import NumberField from "../NumberField.vue";

const props = withDefaults(
  defineProps<{
    /** 展示镜像（调用方持有的 reactive 参数对象；编辑时被就地更新） */
    local: Record<string, unknown>;
    /** 当前类型的参数分组 */
    groups: MaterialParamGroup[];
    /** 统一只读（内置材质） */
    disabled?: boolean;
    /** 贴图通道下拉是否包含 disabled 之外的可编辑限制（如分组未启用） */
    groupDisabled?: (group: MaterialParamGroup) => boolean;
  }>(),
  { disabled: false, groupDisabled: undefined },
);

const emit = defineEmits<{
  editParam: [key: MaterialParamKey | MaterialEnableKey, value: number | boolean | string];
}>();

const assetsStore = getAssetsStore();

function paramValue(key: MaterialParamKey): unknown {
  return props.local[key];
}

function numberValue(key: MaterialParamKey): number {
  const v = paramValue(key);
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function colorValue(key: MaterialParamKey): string {
  const v = paramValue(key);
  return typeof v === "number" ? colorToHexString(v) : "#000000";
}

function boolValue(key: MaterialParamKey | MaterialEnableKey): boolean {
  return props.local[key] === true;
}

function groupEnabled(group: MaterialParamGroup): boolean {
  if (!group.enableKey) return true;
  const gate = props.groupDisabled;
  if (gate) return gate(group);
  return boolValue(group.enableKey);
}

function paramMax(key: MaterialParamKey): number {
  return materialParamMax(key);
}

// —— 贴图通道：内置 + 项目图片资产选择（png/jpg/webp/gif…；空 = 无贴图）——
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "tga", "svg"]);
const textureOptions = computed(() => {
  const internal: { rel: string; name: string }[] = [];
  const project: { rel: string; name: string }[] = [];
  for (const a of assetsStore.assets) {
    if (!IMAGE_EXTS.has(a.kind)) continue;
    if (isInternalAsset(a.path)) internal.push({ rel: a.path, name: a.name });
    else if (a.path.startsWith("assets/")) project.push({ rel: a.path, name: a.name });
  }
  return { internal, project };
});

function textureValue(key: MaterialParamKey): string {
  const v = paramValue(key);
  return typeof v === "string" ? v : "";
}

function isTextureValueListed(key: MaterialParamKey): boolean {
  const cur = textureValue(key);
  if (!cur) return true;
  return textureOptions.value.internal.some((o) => o.rel === cur)
    || textureOptions.value.project.some((o) => o.rel === cur);
}

function onColorEdit(def: MaterialParamDef, e: Event): void {
  const hex = (e.target as HTMLInputElement).value;
  props.local[def.key] = parseColorHex(hex);
  emit("editParam", def.key, parseColorHex(hex));
}

function onNumberEdit(def: MaterialParamDef, v: number): void {
  props.local[def.key] = v;
  emit("editParam", def.key, v);
}

function onBoolEdit(def: MaterialParamDef, e: Event): void {
  const v = (e.target as HTMLInputElement).checked;
  props.local[def.key] = v;
  emit("editParam", def.key, v);
}

function onEnableEdit(key: MaterialEnableKey, e: Event): void {
  const v = (e.target as HTMLInputElement).checked;
  props.local[key] = v;
  emit("editParam", key, v);
}

function onTextureEdit(def: MaterialParamDef, e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  props.local[def.key] = v;
  emit("editParam", def.key, v);
}
</script>

<template>
  <template v-for="group in groups" :key="group.title">
    <div class="mat-group">
      <span class="mat-group-title">{{ group.title }}</span>
      <label v-if="group.enableKey" class="mat-enable" @click.stop>
        <input
          type="checkbox"
          :checked="boolValue(group.enableKey)"
          :disabled="disabled"
          @change="(e) => onEnableEdit(group.enableKey!, e)"
        />
        <span>{{ group.enableLabel }}</span>
      </label>
    </div>
    <template v-for="def in group.defs" :key="def.key">
      <!-- 颜色 -->
      <div v-if="def.kind === 'color'" class="field">
        <label :title="`${def.en}`">{{ def.label }}</label>
        <input
          type="color"
          :value="colorValue(def.key)"
          :disabled="disabled || !groupEnabled(group)"
          @input="(e) => onColorEdit(def, e)"
          @change="(e) => onColorEdit(def, e)"
        />
      </div>
      <!-- 数值 -->
      <div v-else-if="def.kind === 'number'" class="field">
        <label :title="`${def.en}`">{{ def.label }}</label>
        <NumberField
          :model-value="numberValue(def.key)"
          :step="def.step ?? 0.01"
          :min="0"
          :max="paramMax(def.key)"
          :disabled="disabled || !groupEnabled(group)"
          :title="def.en"
          @commit="(v) => onNumberEdit(def, v)"
        />
      </div>
      <!-- 布尔 -->
      <div v-else-if="def.kind === 'bool'" class="field">
        <label :title="`${def.en}`">{{ def.label }}</label>
        <input
          type="checkbox"
          :checked="boolValue(def.key)"
          :disabled="disabled"
          @change="(e) => onBoolEdit(def, e)"
        />
      </div>
      <!-- 贴图 -->
      <div v-else class="field">
        <label :title="`${def.en} 贴图`">{{ def.label }}</label>
        <select
          :value="textureValue(def.key)"
          :disabled="disabled"
          @change="(e) => onTextureEdit(def, e)"
        >
          <option value="">（无贴图）</option>
          <option v-if="!isTextureValueListed(def.key)" :value="textureValue(def.key)" disabled>
            {{ textureValue(def.key) }}
          </option>
          <optgroup label="内置贴图">
            <option v-for="o in textureOptions.internal" :key="o.rel" :value="o.rel" :title="o.rel">
              {{ o.name }}
            </option>
          </optgroup>
          <optgroup label="项目贴图">
            <option v-if="textureOptions.project.length === 0" value="" disabled>
              （项目中暂无图片资产）
            </option>
            <option v-for="o in textureOptions.project" :key="o.rel" :value="o.rel" :title="o.rel">
              {{ o.name }}
            </option>
          </optgroup>
        </select>
      </div>
    </template>
  </template>
</template>

<style scoped>
.mat-group {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dim, #999);
  border-top: 1px solid var(--border, #333);
  padding: 6px 0 2px;
  margin-top: 4px;
}
.mat-group-title {
  flex: 1 1 auto;
}
.mat-enable {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  font-size: 11px;
  font-weight: 400;
  color: var(--text, #ddd);
  cursor: pointer;
}
.mat-enable input {
  margin: 0;
}
.mat-enable input:disabled + span {
  color: var(--text-dim, #999);
}
</style>
