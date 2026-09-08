<script setup lang="ts">
/**
 * 材质（Material）卡片 —— 参数按挂载着色器的渲染分支（工厂注册表 MaterialTypeDef）
 * 数据驱动渲染：PBR（MeshPhysicalMaterial，Blender「原理化 BSDF」分组全量暴露）、
 * Unlit（MeshBasicMaterial，基础色/贴图/输出子集）、Toon（MeshToonMaterial，卡通明暗）。
 * - 顶部：材质资产选择（内置 internal/… 只读 / 项目 assets/materials/… 可写）+ 着色器切换；
 * - 中部：当前渲染分支的全部参数（共享 MaterialParamsEditor 渲染，资产检查器复用同一实现）；
 * - 内置材质只读，先「复制到项目材质」后才能编辑参数/切换着色器。
 */
import { computed, reactive, ref, watch } from "vue";
import { MeshNode } from "../../../framework/prototype/derived/Primitives";
import {
  DEFAULT_MATERIAL_TYPE,
  materialTypeRegistry,
  type MaterialEnableKey,
  type MaterialParamGroup,
  type MaterialParamKey,
} from "../../../framework/material";
import { isInternalAsset } from "../../../lib/internal-assets";
import { loadShaderKind } from "../../lib/shaders";
import {
  useMaterialAssetOptions,
  useShaderAssetOptions,
} from "../../lib/material-options";
import { getAssetsStore } from "../../stores/assets";
import { getEditorStore } from "../../stores/editor";
import { getProjectStore } from "../../stores/project";
import MaterialParamsEditor from "./MaterialParamsEditor.vue";

const props = defineProps<{ node: MeshNode; rev?: number }>();

const emit = defineEmits<{
  setMaterial: [rel: string];
  editParam: [field: MaterialParamKey | MaterialEnableKey, value: number | boolean | string];
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
const local = reactive({ ...editorStore.engine.materials.paramsFor(props.node.material) });
/** 当前渲染分支（= 挂载着色器的种类；随资产切换/着色器变更同步） */
const matType = ref(DEFAULT_MATERIAL_TYPE);
/** 当前挂载的着色器资产引用（下拉展示值） */
const matShader = ref("");

function syncFromEngine(): void {
  const rel = props.node?.material ?? "";
  const p = editorStore.engine.materials.paramsFor(rel);
  Object.assign(local, p);
  matType.value = editorStore.engine.materials.typeFor(rel);
  matShader.value = editorStore.engine.materials.shaderFor(rel);
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

const rel = computed(() => {
  // 节点是普通类实例（非响应式）：以 rev 为失效信号，否则切换/复制材质后徽标停在旧状态
  void props.rev;
  return props.node.material;
});
const isInternal = computed(() => {
  void props.rev;
  return isInternalAsset(props.node.material);
});

/** 当前渲染分支的参数分组（挂载的着色器种类决定属性面板渲染哪些参数） */
const groups = computed<MaterialParamGroup[]>(
  () => materialTypeRegistry.getOrDefault(matType.value).paramGroups,
);

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

/** 切换材质挂载的着色器：本地解析渲染分支即时切分组（父层写引擎缓存是异步链路；
 * 下次 rev 刷新以引擎缓存为准校正），再交父层改写 .mat 并重建视口材质 */
async function onShaderSelect(e: Event): Promise<void> {
  const v = (e.target as HTMLSelectElement).value;
  if (!v || v === matShader.value) return;
  matShader.value = v;
  matType.value = await loadShaderKind(projectStore.currentPath, v);
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
        :title="isInternal ? '内置材质只读；请先复制到项目材质' : '切换材质挂载的着色器（渲染分支与参数分组随之切换）'"
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

    <MaterialParamsEditor
      :local="local"
      :groups="groups"
      :disabled="isInternal"
      @editParam="(k, v) => emit('editParam', k, v)"
    />
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
