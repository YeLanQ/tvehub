<script setup lang="ts">
/**
 * 材质（Material）卡片 —— 参数按材质类型（工厂注册表 MaterialTypeDef）数据驱动渲染：
 *   PBR（MeshPhysicalMaterial，Blender「原理化 BSDF」分组全量暴露）
 *   Unlit（MeshBasicMaterial，基础色/贴图/输出子集）。
 * - 顶部：材质资产选择（内置 internal/… 只读 / 项目 assets/materials/… 可写）+ 类型切换；
 * - 中部：当前材质类型的全部参数（共享 MaterialParamsEditor 渲染，资产检查器复用同一实现）；
 * - 内置材质只读，先「复制到项目材质」后才能编辑参数/切换类型。
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
import { useMaterialAssetOptions } from "../../lib/material-options";
import { getAssetsStore } from "../../stores/assets";
import { getEditorStore } from "../../stores/editor";
import MaterialParamsEditor from "./MaterialParamsEditor.vue";

const props = defineProps<{ node: MeshNode; rev?: number }>();

const emit = defineEmits<{
  setMaterial: [rel: string];
  editParam: [field: MaterialParamKey | MaterialEnableKey, value: number | boolean | string];
  changeType: [type: string];
  copyToProject: [];
}>();

const editorStore = getEditorStore();
const assetsStore = getAssetsStore();

/** 材质资产选项（内置 + 项目；与 Skybox 等共用同一实现） */
const options = useMaterialAssetOptions(() => assetsStore.assets);

/** 已注册材质类型（类型下拉选项；渲染分组也按当前类型 def 取） */
const typeOptions = materialTypeRegistry.list();

/** 本地镜像：展示源。切换材质/参数被编辑后由 syncFromEngine 刷新 */
const local = reactive({ ...editorStore.engine.materials.paramsFor(props.node.material) });
/** 当前材质类型（随资产切换/类型变更同步） */
const matType = ref(DEFAULT_MATERIAL_TYPE);

function syncFromEngine(): void {
  const rel = props.node?.material ?? "";
  const p = editorStore.engine.materials.paramsFor(rel);
  Object.assign(local, p);
  matType.value = editorStore.engine.materials.typeFor(rel);
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

/** 当前类型的参数分组（材质类型决定属性面板渲染哪些参数） */
const groups = computed<MaterialParamGroup[]>(
  () => materialTypeRegistry.getOrDefault(matType.value).paramGroups,
);

function onSelect(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  if (v && v !== props.node.material) emit("setMaterial", v);
}

function onTypeSelect(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  if (v && v !== matType.value) {
    // 本地即时切换参数分组（父层写引擎缓存是异步链路；下次 rev 刷新以引擎缓存为准校正）
    matType.value = v;
    emit("changeType", v);
  }
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
      <label>材质类型</label>
      <select
        :value="matType"
        :disabled="isInternal"
        :title="isInternal ? '内置材质类型固定；请先复制到项目材质' : '切换后改写材质资产并重建视口材质'"
        @change="onTypeSelect"
      >
        <option
          v-if="!typeOptions.some((d) => d.key === matType)"
          :value="matType"
          disabled
        >{{ matType }}（未注册类型）</option>
        <option v-for="def in typeOptions" :key="def.key" :value="def.key">{{ def.label }}</option>
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
