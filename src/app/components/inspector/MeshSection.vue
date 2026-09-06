<script setup lang="ts">
/**
 * Mesh 卡片：网格来源（基元/模型）+ 对应参数。
 * - 基元：几何类型（几何工厂注册表驱动）下拉；
 * - 模型：模型资产下拉（glb/gltf/fbx/obj；材质/动画由模型内嵌），
 *   未就绪时同步器渲染占位体，加载完成后自动替换。
 */
import { computed } from "vue";
import { MeshNode } from "../../../framework/prototype/derived/Primitives";
import { geometryRegistry, isModelAssetRel } from "../../../framework/mesh";
import { getAssetsStore } from "../../stores/assets";
import { isInternalAsset } from "../../../lib/internal-assets";

const props = defineProps<{ node: MeshNode; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

/** 几何类型选项（注册表驱动：新增基元自动出现在下拉） */
const geometryOptions = geometryRegistry.list();

/** 模型资产选项（内置 + 项目） */
const modelOptions = computed(() => {
  void props.rev;
  const assets = getAssetsStore().assets;
  const internal: { rel: string; name: string }[] = [];
  const project: { rel: string; name: string }[] = [];
  for (const a of assets) {
    if (a.kind === "dir" || !isModelAssetRel(a.path)) continue;
    const entry = { rel: a.path, name: a.name };
    if (isInternalAsset(a.path)) internal.push(entry);
    else project.push(entry);
  }
  return { internal, project };
});

/** 当前模型引用是否在可选列表中（不在则显示禁用占位项，避免显示空） */
const isListed = computed(() => {
  void props.rev;
  const cur = props.node.model;
  if (!cur) return true;
  const o = modelOptions.value;
  return o.internal.some((x) => x.rel === cur) || o.project.some((x) => x.rel === cur);
});

function onSourceChange(e: Event): void {
  const value = (e.target as HTMLSelectElement).value;
  emit("update", "Set Mesh Source", value);
}

function onGeometryChange(e: Event): void {
  const value = (e.target as HTMLSelectElement).value;
  emit("update", "Set Geometry", value);
}

function onModelChange(e: Event): void {
  const value = (e.target as HTMLSelectElement).value;
  emit("update", "Set Model", value);
}
</script>

<template>
  <div class="mesh-section" :data-rev="rev">
    <div class="field">
      <label>网格来源</label>
      <select :value="node.source" @change="onSourceChange($event)">
        <option value="primitive">基元（Primitive）</option>
        <option value="model">模型（Model）</option>
      </select>
    </div>

    <template v-if="node.source === 'primitive'">
      <div class="field">
        <label>Geometry</label>
        <select :value="node.geometry" @change="onGeometryChange($event)">
          <option v-for="g in geometryOptions" :key="g.key" :value="g.key">{{ g.label }}</option>
        </select>
      </div>
    </template>

    <template v-else>
      <div class="field">
        <label>模型资产</label>
        <select :value="node.model" @change="onModelChange($event)">
          <option value="">（未选择模型）</option>
          <option v-if="!isListed" :value="node.model" disabled>{{ node.model }}</option>
          <optgroup label="内置模型">
            <option v-for="o in modelOptions.internal" :key="o.rel" :value="o.rel" :title="o.rel">
              {{ o.name }}
            </option>
          </optgroup>
          <optgroup label="项目模型">
            <option v-if="modelOptions.project.length === 0" value="" disabled>
              （导入 glb/gltf/fbx/obj 后在此选择）
            </option>
            <option v-for="o in modelOptions.project" :key="o.rel" :value="o.rel" :title="o.rel">
              {{ o.name }}
            </option>
          </optgroup>
        </select>
      </div>
      <div class="hint">几何/材质随模型内嵌；动画在下方 Animation 卡片配置。</div>
    </template>
  </div>
</template>
