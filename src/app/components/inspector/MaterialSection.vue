<script setup lang="ts">
/**
 * 材质（Material）卡片 —— 参数面向 three 的 PBR 材质（MeshPhysicalMaterial），
 * 与 Blender「原理化 BSDF」节点属性对应并按分组全量暴露（见 framework/material/defs）：
 *   基础 Base / 高光 Specular / 自发光 Emission / 清漆 Clearcoat /
 *   光泽 Sheen / 透射 Transmission / 高级 Advanced。
 * - 顶部：材质资产选择（内置 internal/… 只读 / 项目 assets/materials/… 可写）；
 * - 中部：当前材质资产的全部 PBR 参数（颜色用取色器、数值用 NumberField）；
 * - 内置材质只读，先「复制到项目材质」后才能编辑参数。
 */
import { computed, reactive, watch } from "vue";
import { MeshNode } from "../../../framework/prototype/derived/Primitives";
import {
  MATERIAL_PARAM_GROUPS,
  colorToHexString,
  materialParamMax,
  parseColorHex,
  type MaterialEnableKey,
  type MaterialParamDef,
  type MaterialParamGroup,
  type MaterialParamKey,
} from "../../../framework/material";
import { isInternalAsset } from "../../../lib/internal-assets";
import { useMaterialAssetOptions } from "../../lib/material-options";
import { getAssetsStore } from "../../stores/assets";
import { getEditorStore } from "../../stores/editor";
import NumberField from "../NumberField.vue";

const props = defineProps<{ node: MeshNode; rev?: number }>();

const emit = defineEmits<{
  setMaterial: [rel: string];
  editParam: [field: MaterialParamKey | MaterialEnableKey, value: number | boolean | string];
  copyToProject: [];
}>();

const editorStore = getEditorStore();
const assetsStore = getAssetsStore();

/** 材质资产选项（内置 + 项目；与 Skybox 等共用同一实现） */
const options = useMaterialAssetOptions(() => assetsStore.assets);

/** 本地镜像：展示源。切换材质/参数被编辑后由 syncFromEngine 刷新 */
const local = reactive({ ...editorStore.engine.materials.paramsFor(props.node.material) });

function syncFromEngine(): void {
  const p = editorStore.engine.materials.paramsFor(props.node?.material ?? "");
  Object.assign(local, p);
}

watch(
  () => props.node?.material,
  () => syncFromEngine(),
  { immediate: true },
);
watch(
  () => props.rev,
  () => syncFromEngine(),
);

const rel = computed(() => props.node.material);
const isInternal = computed(() => isInternalAsset(props.node.material));

function onSelect(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  if (v && v !== props.node.material) emit("setMaterial", v);
}

// —— 通用参数读写（按 defs 渲染，避免每个参数手写控件）——
function paramValue(key: MaterialParamKey): unknown {
  return (local as unknown as Record<string, unknown>)[key];
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
  return (local as unknown as Record<string, unknown>)[key] === true;
}

function onColorEdit(def: MaterialParamDef, e: Event): void {
  const hex = (e.target as HTMLInputElement).value;
  // 先就地更新镜像（即时反馈），再交给父层持久化（内置材质只读不会触发）
  (local as unknown as Record<string, unknown>)[def.key] = parseColorHex(hex);
  emit("editParam", def.key, parseColorHex(hex));
}

function onNumberEdit(def: MaterialParamDef, v: number): void {
  (local as unknown as Record<string, unknown>)[def.key] = v;
  emit("editParam", def.key, v);
}

function onBoolEdit(def: MaterialParamDef, e: Event): void {
  const v = (e.target as HTMLInputElement).checked;
  (local as unknown as Record<string, unknown>)[def.key] = v;
  emit("editParam", def.key, v);
}

function onEnableEdit(key: MaterialEnableKey, e: Event): void {
  const v = (e.target as HTMLInputElement).checked;
  (local as unknown as Record<string, unknown>)[key] = v;
  emit("editParam", key, v);
}

/** 分组是否启用：无开关的分组恒为启用；有开关的分组由开关值决定 */
function groupEnabled(group: MaterialParamGroup): boolean {
  return !group.enableKey || boolValue(group.enableKey);
}

function paramMax(key: MaterialParamKey): number {
  return materialParamMax(key);
}

// —— 贴图通道：内置 + 项目图片资产选择（png/jpg/webp/gif…；空 = 无贴图）——
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "tga", "svg"]);
const textureOptions = computed(() => {
  const internal: { rel: string; name: string; internal: boolean }[] = [];
  const project: { rel: string; name: string; internal: boolean }[] = [];
  for (const a of assetsStore.assets) {
    if (!IMAGE_EXTS.has(a.kind)) continue;
    if (isInternalAsset(a.path)) {
      internal.push({ rel: a.path, name: a.name, internal: true });
    } else if (a.path.startsWith("assets/")) {
      project.push({ rel: a.path, name: a.name, internal: false });
    }
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

function onTextureEdit(def: MaterialParamDef, e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  (local as unknown as Record<string, unknown>)[def.key] = v;
  emit("editParam", def.key, v);
}

const groups = MATERIAL_PARAM_GROUPS;
</script>

<template>
  <div class="mat-section" :data-rev="rev">
    <div class="field">
      <label>材质资产</label>
      <select :value="node.material" @change="onSelect">
        <optgroup label="内置材质">
          <option v-for="o in options.internal" :key="o.rel" :value="o.rel">{{ o.name }}</option>
        </optgroup>
        <optgroup label="项目材质">
          <option v-if="options.project.length === 0" value="" disabled>（assets/materials 下暂无材质）</option>
          <option v-for="o in options.project" :key="o.rel" :value="o.rel">{{ o.name }}</option>
        </optgroup>
      </select>
    </div>

    <div class="field mat-meta">
      <span class="mat-badge" :class="{ internal: isInternal }">
        {{ isInternal ? "内置 · 只读" : "项目材质" }}
      </span>
      <span class="mat-rel mono">{{ rel }}</span>
      <button
        class="mat-btn"
        :title="isInternal ? '复制为项目材质资产并绑定到本节点（可编辑）' : '从当前材质新建一份独立副本并绑定到本节点'"
        @click="emit('copyToProject')"
      >
        {{ isInternal ? "复制到项目材质" : "另存副本" }}
      </button>
    </div>

    <div v-if="isInternal" class="hint">内置材质只读；如需调整参数，请先「复制到项目材质」。</div>
    <div v-else class="hint">参数写入 .mat 资产文件，引用该材质的所有网格同步更新。</div>

    <template v-for="group in groups" :key="group.title">
      <div class="mat-group">
        <span class="mat-group-title">{{ group.title }}</span>
        <label v-if="group.enableKey" class="mat-enable" @click.stop>
          <input
            type="checkbox"
            :checked="boolValue(group.enableKey)"
            :disabled="isInternal"
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
            :disabled="isInternal || !groupEnabled(group)"
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
            :disabled="isInternal || !groupEnabled(group)"
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
            :disabled="isInternal"
            @change="(e) => onBoolEdit(def, e)"
          />
        </div>
        <!-- 贴图 -->
        <div v-else class="field">
          <label :title="`${def.en} 贴图`">{{ def.label }}</label>
          <select
            :value="textureValue(def.key)"
            :disabled="isInternal"
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
  </div>
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
.mat-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.mat-badge {
  font-size: 11px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 3px;
  border: 1px solid var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
.mat-badge.internal {
  border-color: var(--text-dim, #888);
  color: var(--text-dim, #888);
}
.mat-rel {
  flex: 1 1 auto;
  min-width: 90px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-dim, #999);
}
.mat-btn {
  flex: none;
  font-size: 11px;
  line-height: 1.2;
  padding: 3px 8px;
  border-radius: 3px;
  border: 1px solid var(--text-dim, #666);
  background: transparent;
  color: var(--text, #ddd);
  cursor: pointer;
}
.mat-btn:hover {
  border-color: var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
</style>
