<script setup lang="ts">
/**
 * 材质参数编辑器（数据驱动，按 MaterialParamGroup[] 渲染全部暴露参数）：
 * 从 MaterialSection 抽出共享——节点材质卡片与资产检查器的材质编辑共用同一份实现。
 * props.local 为展示镜像（调用方持有并在编辑时被就地更新），disabled 统一控制只读。
 * 参数字段名对内建分支为 MaterialParamKey，对自定义着色器为属性名（任意 _ 前缀标识符），
 * 因此事件负载用 string；自定义属性自带上/下界（def.min/def.max），缺省走内置收敛规则。
 */
import { computed } from "vue";
import {
  colorToHexString,
  materialParamMax,
  parseColorHex,
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
  editParam: [key: string, value: number | boolean | string | number[]];
}>();

const assetsStore = getAssetsStore();

function paramValue(key: string): unknown {
  return props.local[key];
}

function numberValue(key: string): number {
  const v = paramValue(key);
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function colorValue(key: string): string {
  const v = paramValue(key);
  return typeof v === "number" ? colorToHexString(v) : "#000000";
}

function boolValue(key: string): boolean {
  return props.local[key] === true;
}

/** 向量分量（[x, y, z, w]；缺省 0） */
function vectorValue(key: string, index: number): number {
  const v = paramValue(key);
  if (!Array.isArray(v)) return 0;
  const n = v[index];
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function groupEnabled(group: MaterialParamGroup): boolean {
  if (!group.enableKey) return true;
  const gate = props.groupDisabled;
  if (gate) return gate(group);
  return boolValue(group.enableKey);
}

/** 数值上界：自定义属性取声明（def.max），内置参数走收敛规则 */
function paramMax(def: MaterialParamDef): number {
  if (typeof def.max === "number") return def.max;
  return materialParamMax(def.key as MaterialParamKey);
}

function paramMin(def: MaterialParamDef): number {
  return typeof def.min === "number" ? def.min : 0;
}

function stepOf(def: MaterialParamDef): number {
  return def.step ?? 0.01;
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

function textureValue(key: string): string {
  const v = paramValue(key);
  return typeof v === "string" ? v : "";
}

function isTextureValueListed(key: string): boolean {
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

function onVectorEdit(def: MaterialParamDef, index: number, v: number): void {
  const v0 = paramValue(def.key);
  const next = Array.isArray(v0) ? [...v0] : [0, 0, 0, 0];
  while (next.length < 4) next.push(0);
  next[index] = v;
  props.local[def.key] = next;
  emit("editParam", def.key, next);
}

function onBoolEdit(def: MaterialParamDef, e: Event): void {
  const v = (e.target as HTMLInputElement).checked;
  props.local[def.key] = v;
  emit("editParam", def.key, v);
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
          @change="(e) => onBoolEdit({ key: group.enableKey!, label: '', en: '', kind: 'bool' }, e)"
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
          :step="stepOf(def)"
          :min="paramMin(def)"
          :max="paramMax(def)"
          :disabled="disabled || !groupEnabled(group)"
          :title="def.en"
          @commit="(v) => onNumberEdit(def, v)"
        />
      </div>
      <!-- 向量（四分量：自定义着色器 Vector 属性） -->
      <div v-else-if="def.kind === 'vector'" class="field">
        <label :title="`${def.en}`">{{ def.label }}</label>
        <div class="vec-row">
          <NumberField
            v-for="i in 4"
            :key="i"
            :model-value="vectorValue(def.key, i - 1)"
            :step="stepOf(def)"
            :disabled="disabled || !groupEnabled(group)"
            :title="`${def.en}.${'xyzw'[i - 1]}`"
            @commit="(v) => onVectorEdit(def, i - 1, v)"
          />
        </div>
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
.vec-row {
  display: flex;
  gap: 4px;
  flex: 1 1 auto;
  min-width: 0;
}
.vec-row :deep(.nf-input) {
  flex: 1 1 0;
  min-width: 0;
}
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
