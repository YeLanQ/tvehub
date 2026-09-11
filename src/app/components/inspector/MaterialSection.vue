<script setup lang="ts">
/**
 * 材质（Material）卡片 —— 参数按所挂着色器的渲染分支（工厂注册表 MaterialTypeDef）
 * 数据驱动渲染：PBR（MeshPhysicalMaterial，「原理化 BSDF」分组全量暴露）、
 * Unlit（MeshBasicMaterial，基础色/贴图/输出子集）、Toon（MeshToonMaterial，卡通明暗）。
 * - 顶部：材质资产选择（内置 internal/… 只读 / 项目 assets/materials/… 可写）+ 着色器切换；
 *   着色器决定渲染分支（其 Base 声明）与自定义效果的 Hook 片段；
 * - 中部：当前渲染分支的全部参数 + 所挂着色器 Properties 暴露的参数（共享
 *   MaterialParamsEditor 渲染，资产检查器复用同一实现）；
 * - 内置材质只读，先「复制到项目材质」后才能编辑参数/切换着色器。
 */
import { computed, reactive, ref, watch } from "vue";
import { MeshNode } from "../../../framework/prototype/derived/Primitives";
import {
  DEFAULT_MATERIAL_TYPE,
  materialTypeRegistry,
  shaderParamGroups,
  shaderPropDefaults,
  type MaterialEnableKey,
  type MaterialParamGroup,
  type MaterialParamKey,
  type ShaderPropertyDef,
} from "../../../framework/material";
import { isInternalAsset } from "../../../lib/internal-assets";
import { loadShaderDoc, loadShaderKind } from "../../lib/shaders";
import { useMaterialAssetOptions, useShaderAssetOptions } from "../../lib/material-options";
import { getAssetsStore } from "../../stores/assets";
import { getEditorStore } from "../../stores/editor";
import { getProjectStore } from "../../stores/project";
import MaterialParamsEditor from "./MaterialParamsEditor.vue";

const props = defineProps<{ node: MeshNode; rev?: number }>();

const emit = defineEmits<{
  setMaterial: [rel: string];
  editParam: [field: MaterialParamKey | MaterialEnableKey, value: number | boolean | string];
  /** 着色器 Properties 参数编辑（props 字段；key = 属性名） */
  editProp: [key: string, value: number | string | number[]];
  changeShader: [rel: string];
  copyToProject: [];
}>();

const editorStore = getEditorStore();
const assetsStore = getAssetsStore();
const projectStore = getProjectStore();

/** 材质/着色器资产选项（内置 + 项目；与 Skybox 等共用同一实现） */
const options = useMaterialAssetOptions(() => assetsStore.assets);
const shaderOptions = useShaderAssetOptions(() => assetsStore.assets);

/** 本地镜像：展示源。切换材质/参数被编辑后由 syncFromEngine 刷新 */
const local = reactive<Record<string, unknown>>(
  { ...editorStore.engine.materials.paramsFor(props.node.material) },
);
/** 着色器参数镜像（props；键 = 属性名） */
const shaderLocal = reactive<Record<string, unknown>>({});
/** 当前渲染分支（= 所挂着色器的 Base；随资产切换/着色器变更同步） */
const matType = ref(DEFAULT_MATERIAL_TYPE);
/** 当前挂载的着色器资产引用（下拉展示值） */
const matShader = ref("");

/** 所挂着色器的文档（引擎着色器缓存；未解析为 null） */
const shaderDoc = computed(() =>
  matShader.value ? editorStore.engine.shaders.docFor(matShader.value) : null,
);
/** 着色器暴露的属性表（面板参数分组用；未解析为空表） */
const shaderProps = computed<ShaderPropertyDef[]>(() => shaderDoc.value?.properties ?? []);
/** 着色器解析错误（null = 无错误；非 null 时仍按 Base 分支渲染，只是不叠效果） */
const shaderError = computed(() => (matShader.value ? (shaderDoc.value?.error ?? null) : null));
/** 着色器参数分组（由 Properties 动态构造） */
const propGroups = computed<MaterialParamGroup[]>(() => shaderParamGroups(shaderProps.value));

/** 就地替换展示镜像（切换材质/着色器时属性集合变化，避免残留旧字段） */
function replaceLocal(next: Record<string, unknown>): void {
  for (const key of Object.keys(local)) delete local[key];
  Object.assign(local, next);
}

/** 就地替换着色器参数镜像 */
function replaceShaderLocal(next: Record<string, unknown>): void {
  for (const key of Object.keys(shaderLocal)) delete shaderLocal[key];
  Object.assign(shaderLocal, next);
}

function syncFromEngine(): void {
  const rel = props.node?.material ?? "";
  const p = editorStore.engine.materials.paramsFor(rel);
  matType.value = editorStore.engine.materials.typeFor(rel);
  matShader.value = editorStore.engine.materials.shaderFor(rel);
  // 着色器参数镜像 = 属性默认值 + .mat 已存 props
  replaceShaderLocal({ ...shaderPropDefaults(shaderProps.value), ...p.props });
  replaceLocal({ ...p });
}

/** 确保当前着色器的文档已解析（面板取属性/引擎取钩子；缺失时先取占位） */
function ensureShaderDoc(): void {
  const rel = matShader.value;
  if (!rel || editorStore.engine.shaders.has(rel)) return;
  void loadShaderDoc(projectStore.currentPath, rel).then((doc) => {
    if (!doc) return;
    // 写入缓存即广播：引擎按钩子刷新引用该着色器的网格（先默认外观 → 叠加效果）
    editorStore.engine.shaders.cachePut(rel, doc);
  });
}

watch(
  () => props.node?.material,
  () => {
    syncFromEngine();
    ensureShaderDoc();
  },
  { immediate: true },
);
watch(
  () => props.rev,
  () => {
    syncFromEngine();
    ensureShaderDoc();
  },
);

const rel = computed(() => {
  // 节点是普通类实例（非响应式）：以 rev 为失效信号，否则切换/复制材质后徽标停在旧状态
  void props.rev;
  return props.node.material;
});
const isInternal = computed(() => {
  void props.rev;
  return isInternalAsset(props.node.material);
});

/** 渲染分支的参数分组（取类型定义）；着色器参数单独一组追加在后 */
const groups = computed<MaterialParamGroup[]>(() => [
  ...materialTypeRegistry.getOrDefault(matType.value).paramGroups,
  ...propGroups.value,
]);

/** 挂载的着色器是否不在可选项中（空串 = 旧格式未挂载；有值但缺失 = 文件被删） */
const matShaderMissing = computed(
  () =>
    !!matShader.value &&
    !shaderOptions.value.internal.some((o) => o.rel === matShader.value) &&
    !shaderOptions.value.project.some((o) => o.rel === matShader.value),
);

function onSelect(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  if (v && v !== props.node.material) emit("setMaterial", v);
}

/** 参数编辑分流：分支参数字段 → .mat 顶字段；着色器属性 → .mat 的 props */
function onParamEdit(key: string, value: number | boolean | string | number[]): void {
  if (shaderProps.value.some((p) => p.key === key)) {
    // 着色器属性无布尔项（布尔由启用开关/分组承担）
    if (typeof value === "boolean") return;
    emit("editProp", key, value);
    return;
  }
  emit(
    "editParam",
    key as MaterialParamKey | MaterialEnableKey,
    value as number | boolean | string,
  );
}

/** 切换材质挂载的着色器：本地解析渲染分支即时切分组（父层写引擎缓存是异步链路；
 * 下次 rev 刷新以引擎缓存为准校正），再交父层改写 .mat 并重建视口材质 */
async function onShaderSelect(e: Event): Promise<void> {
  const v = (e.target as HTMLSelectElement).value;
  if (!v || v === matShader.value) return;
  matShader.value = v;
  matType.value = await loadShaderKind(projectStore.currentPath, v);
  ensureShaderDoc();
  emit("changeShader", v);
}
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

    <div class="field">
      <label>着色器</label>
      <select
        :value="matShader"
        :disabled="isInternal"
        :title="isInternal ? '内置材质只读；请先复制到项目材质' : '切换材质挂载的着色器（渲染分支与参数、效果随之切换）'"
        @change="onShaderSelect"
      >
        <option v-if="!matShader" value="" disabled>（未挂载，默认 PBR）</option>
        <option v-if="matShaderMissing" :value="matShader" disabled>{{ matShader }}（缺失）</option>
        <optgroup label="内置着色器">
          <option v-for="o in shaderOptions.internal" :key="o.rel" :value="o.rel">{{ o.name }}</option>
        </optgroup>
        <optgroup label="项目着色器">
          <option v-if="shaderOptions.project.length === 0" value="" disabled>（项目内暂无 .shader，可在资产面板「新建着色器」）</option>
          <option v-for="o in shaderOptions.project" :key="o.rel" :value="o.rel">{{ o.name }}</option>
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
    <div v-if="shaderError" class="hint hint-error">
      着色器解析失败（仍按当前分支渲染，只是不叠加效果）：{{ shaderError }}
    </div>

    <MaterialParamsEditor
      :local="shaderProps.length > 0 ? { ...local, ...shaderLocal } : local"
      :groups="groups"
      :disabled="isInternal"
      @editParam="onParamEdit"
    />
  </div>
</template>

<style scoped>
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
