<script setup lang="ts">
/**
 * 天空盒（Skybox）卡片：
 * - 类型固定（创建时由菜单决定），只读展示；
 * - 「材质资产」选择与 Material 卡片完全一致（同一份实现 useMaterialAssetOptions）：
 *   内置材质（internal/materials/…） + 项目材质（assets/… 全部 .mat）；
 * - 天空的全部表现都在天空盒材质资产中配置（资产面板选中材质 → 属性面板编辑）：
 *   立方体 = TextureCube + 旋转/强度/模糊；程序化 = Nishita 大气散射（三色/
 *   日轮/太阳尺寸/强度/高度/旋转/海拔/空气/气溶胶/臭氧/多重散射）；
 * - 节点上的历史配色/太阳字段仅作为「未绑定材质」时的引擎兜底，不再在此编辑。
 */
import { computed } from "vue";
import { SkyboxNode } from "../../../framework/prototype/derived/Primitives";
import { isInternalAsset } from "../../../lib/internal-assets";
import { useMaterialAssetOptions } from "../../lib/material-options";
import { getAssetsStore } from "../../stores/assets";

const props = defineProps<{ node: SkyboxNode; rev?: number }>();

const emit = defineEmits<{
  setMaterial: [rel: string];
  copyToProject: [];
}>();

const assetsStore = getAssetsStore();

/** 材质资产选项（与 Material 卡片共用；内置 + 项目全部 .mat） */
const options = useMaterialAssetOptions(() => assetsStore.assets);

/** 当前类型（固定）。节点是普通类实例（非响应式）：以 rev 为失效信号 */
const kindLabel = computed(() => {
  void props.rev;
  return props.node.skyKind === "procedural" ? "程序化天空盒" : "立方体天空盒（TextureCube）";
});

const isInternal = computed(() => {
  void props.rev;
  return isInternalAsset(props.node.material);
});

function onSelect(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  if (v && v !== props.node.material) emit("setMaterial", v);
}
</script>

<template>
  <div :data-rev="rev">
    <div class="field">
      <label>类型</label>
      <span class="type-tag">{{ kindLabel }}</span>
      <span class="muted">创建后固定</span>
    </div>

    <div class="field">
      <label>材质资产</label>
      <select :value="node.material" @change="onSelect">
        <optgroup label="内置材质">
          <option v-for="o in options.internal" :key="o.rel" :value="o.rel">{{ o.name }}</option>
        </optgroup>
        <optgroup label="项目材质">
          <option v-if="options.project.length === 0" value="" disabled>
            （assets/materials 下暂无材质）
          </option>
          <option v-for="o in options.project" :key="o.rel" :value="o.rel">{{ o.name }}</option>
        </optgroup>
      </select>
    </div>

    <div class="sky-mat-meta">
      <span class="sky-mat-badge" :class="{ internal: isInternal }">
        {{ isInternal ? "内置 · 只读" : "项目材质" }}
      </span>
      <span class="sky-mat-rel mono">{{ node.material }}</span>
      <button
        v-if="isInternal"
        class="sky-mat-btn"
        title="复制为项目材质资产并绑定到本节点"
        @click="emit('copyToProject')"
      >
        复制到项目材质
      </button>
    </div>

    <div class="muted sky-note">
      {{
        node.skyKind === "procedural"
          ? "程序化天空的三色、日轮与太阳参数在绑定的天空盒材质资产中配置：资产面板选中该材质 → 属性面板编辑（内置材质可先复制到项目）。"
          : "立方体贴图与旋转/强度/模糊等参数在绑定的天空盒材质资产中配置：资产面板选中该材质 → 属性面板编辑（内置材质可先复制到项目）。"
      }}
    </div>
    <div class="muted sky-note">
      未绑定材质时按节点历史配色/太阳参数兜底渲染。
    </div>
  </div>
</template>

<style scoped>
.sky-mat-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.sky-mat-badge {
  font-size: 11px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 3px;
  border: 1px solid var(--text-dim, #888);
  color: var(--text-dim, #888);
}
.sky-mat-badge:not(.internal) {
  border-color: var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
.sky-mat-rel {
  flex: 1 1 auto;
  min-width: 90px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-dim, #999);
}
.sky-mat-btn {
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
.sky-mat-btn:hover {
  border-color: var(--accent, #4a9eff);
  color: var(--accent, #4a9eff);
}
.sky-note {
  font-size: 11px;
  padding: 2px 0;
}
</style>
