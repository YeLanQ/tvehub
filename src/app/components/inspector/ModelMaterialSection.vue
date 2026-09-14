<script setup lang="ts">
/**
 * 模型内嵌材质卡片（source=model 的网格）：
 * - 列出模型自带材质（名称 + 类型标签）与各槽位的替换状态；
 * - 「提取材质到编辑器」（仅 glTF/GLB）：把内嵌材质（PBR 参数 + png/jpeg 贴图）
 *   提取为 .mat 材质资产（贴图写 assets/textures、材质写 assets/materials），
 *   并自动填满各槽位的替换映射（一次撤销，可再逐槽调整）；
 * - 每槽位一个材质下拉（内置 + 项目 .mat；空 = 用原始内嵌材质），替换在视口
 *   立即生效（引擎按覆盖表替换实例材质，不改共享模板）。
 */
import { computed, ref } from "vue";
import { MeshNode } from "../../../framework/prototype/derived/Primitives";
import type { ModelMaterialInfo } from "../../../framework/mesh";
import { isGltfAssetRel } from "../../../framework/mesh";
import { getEditorStore } from "../../stores/editor";
import { getProjectStore } from "../../stores/project";
import { getAssetsStore } from "../../stores/assets";
import { logStore } from "../../stores/log";
import { useMaterialAssetOptions } from "../../lib/material-options";
import {
  extractAndWriteModelMaterials,
  type ModelMaterialExtractResult,
} from "../../lib/model-extract";

const props = defineProps<{ node: MeshNode; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

const projectStore = getProjectStore();
const assetsStore = getAssetsStore();
const materialOptions = useMaterialAssetOptions(() => assetsStore.assets);

/** 内嵌材质清单（随 model:changed 的 rev 刷新） */
const materials = computed<ModelMaterialInfo[]>(() => {
  void props.rev;
  return props.node.model
    ? (getEditorStore().engine.models.metaFor(props.node.model)?.materials ?? [])
    : [];
});

/** 当前覆盖表（rev 失效重读；节点为普通类实例） */
const overrides = computed<Record<string, string>>(() => {
  void props.rev;
  return props.node.modelMaterialOverrides ?? {};
});

const overriddenCount = computed(() => Object.keys(overrides.value).length);

/** 仅 glTF/GLB 支持提取（fbx/obj 无 glTF 文档可解析） */
const extractable = computed(() => isGltfAssetRel(props.node.model));

const extracting = ref(false);
async function onExtract(): Promise<void> {
  const root = projectStore.currentPath;
  if (!root || extracting.value || !props.node.model) return;
  extracting.value = true;
  try {
    const usedRels = new Set(assetsStore.assets.map((a) => a.path.toLowerCase()));
    const result: ModelMaterialExtractResult = await extractAndWriteModelMaterials(
      root,
      props.node.model,
      usedRels,
    );
    await assetsStore.load(root);
    emit("update", "Apply Extracted Materials", result.overrides);
    logStore.log(
      "success",
      `已提取模型材质: ${result.materials} 个材质` +
        (result.textures ? `、${result.textures} 张贴图` : "") +
        " → assets/materials（槽位替换已应用）",
    );
  } catch (e) {
    logStore.log("error", `提取模型材质失败: ${e instanceof Error ? e.message : e}`);
  } finally {
    extracting.value = false;
  }
}

function onSlotChange(name: string, rel: string): void {
  emit("update", "Set Model Material Slot", { name, rel });
}

function onClear(): void {
  emit("update", "Clear Model Material Overrides", null);
}
</script>

<template>
  <div class="mmat-section" :data-rev="rev">
    <div class="mmat-actions">
      <button
        :disabled="!props.node.model || !extractable || extracting"
        :title="extractable ? '提取内嵌材质（PBR 参数 + 贴图）为 .mat 材质资产，并应用到各槽位' : '仅 glTF/GLB 模型支持材质提取'"
        @click="onExtract"
      >
        {{ extracting ? "提取中…" : "提取材质到编辑器" }}
      </button>
      <button
        v-if="overriddenCount > 0"
        title="清除全部槽位替换，恢复模型内嵌材质"
        @click="onClear"
      >
        全部还原
      </button>
    </div>

    <div v-if="materials.length === 0" class="hint">模型加载中或无内嵌材质。</div>
    <div v-for="(m, i) in materials" :key="i" class="mmat-row">
      <span class="mmat-name" :title="m.name">{{ m.name }}</span>
      <span class="mmat-type mono">{{ m.type }}</span>
      <select
        class="mmat-select"
        :value="overrides[m.name] ?? ''"
        :title="overrides[m.name] ? '已替换为编辑器材质' : '使用原始内嵌材质'"
        @change="onSlotChange(m.name, ($event.target as HTMLSelectElement).value)"
      >
        <option value="">（原始材质）</option>
        <option
          v-if="overrides[m.name] && ![...materialOptions.internal, ...materialOptions.project].some((o) => o.rel === overrides[m.name])"
          :value="overrides[m.name]"
        >
          {{ overrides[m.name] }}（未找到）
        </option>
        <optgroup v-if="materialOptions.project.length" label="项目材质">
          <option v-for="o in materialOptions.project" :key="o.rel" :value="o.rel">{{ o.name }}</option>
        </optgroup>
        <optgroup v-if="materialOptions.internal.length" label="内置材质">
          <option v-for="o in materialOptions.internal" :key="o.rel" :value="o.rel">{{ o.name }}</option>
        </optgroup>
      </select>
    </div>
    <div class="hint">
      原始材质与模型模板共享（编辑会跨实例串改）；调整请先「提取材质到编辑器」或选择项目材质——
      替换按材质名逐槽生效，随场景保存。
    </div>
  </div>
</template>

<style scoped>
.mmat-actions {
  display: flex;
  gap: 6px;
  padding: 2px 0 4px;
}
.mmat-actions button {
  font-size: 11px;
  line-height: 1.4;
  padding: 3px 8px;
  border-radius: 3px;
  border: 1px solid var(--border, #555);
  background: #333;
  color: var(--text, #ddd);
  cursor: pointer;
}
.mmat-actions button:hover:not(:disabled) {
  border-color: var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
.mmat-actions button:disabled {
  opacity: 0.5;
  cursor: default;
}
.mmat-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
}
.mmat-name {
  flex: 1 1 auto;
  min-width: 56px;
  font-size: 11px;
  color: var(--text, #ddd);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mmat-type {
  flex: none;
  font-size: 10px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 3px;
  border: 1px solid var(--border, #444);
  color: var(--text-dim, #999);
}
.mmat-select {
  flex: none;
  width: 118px;
  max-width: 118px;
  font-size: 11px;
  padding: 2px 4px;
  background: #252526;
  color: var(--text, #ddd);
  border: 1px solid var(--border, #444);
  border-radius: 3px;
}
</style>
