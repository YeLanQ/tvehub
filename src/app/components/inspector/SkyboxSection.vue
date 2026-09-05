<script setup lang="ts">
/**
 * 天空盒（Skybox）卡片：
 * - 类型固定（创建时由菜单决定），只读展示；
 * - 「材质资产」选择与 Material 卡片完全一致（同一份实现 useMaterialAssetOptions）：
 *   内置材质（internal/materials/…） + 项目材质（assets/… 全部 .mat）。
 *   Skybox 使用的是一种特殊材质（.mat 中 shader/kind 区分程序化/立方体）；
 * - 天空配色（顶/地平线/下方）为节点参数，直接可调。
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
  update: [label: string, value: unknown];
}>();

const assetsStore = getAssetsStore();

/** 材质资产选项（与 Material 卡片共用；内置 + 项目全部 .mat） */
const options = useMaterialAssetOptions(() => assetsStore.assets);

/** 当前类型（固定） */
const kindLabel = computed(() =>
  props.node.skyKind === "procedural" ? "程序化天空盒" : "默认立方体天空盒",
);

/** 程序化 / 立方体的色项标签（同字段、不同语义命名） */
const colorLabels = computed<{ top: string; horizon: string; ground: string }>(() =>
  props.node.skyKind === "procedural"
    ? { top: "天空顶部色", horizon: "地平线色", ground: "下方地面色" }
    : { top: "顶面颜色", horizon: "侧面颜色", ground: "底面颜色" },
);

const isInternal = computed(() => isInternalAsset(props.node.material));

function onSelect(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  if (v && v !== props.node.material) emit("setMaterial", v);
}

function numToHex(v: number): string {
  return "#" + (v & 0xffffff).toString(16).padStart(6, "0");
}

function hexToNum(hex: string): number {
  const v = parseInt(hex.replace("#", ""), 16);
  return Number.isNaN(v) ? 0xffffff : v & 0xffffff;
}

function onColorChange(key: "top" | "horizon" | "ground", hex: string): void {
  const label =
    key === "top" ? "Set Top Color" : key === "horizon" ? "Set Horizon Color" : "Set Ground Color";
  emit("update", label, hexToNum(hex));
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

    <div class="field">
      <label>{{ colorLabels.top }}</label>
      <input
        type="color"
        :value="numToHex(node.topColor)"
        @input="(e) => onColorChange('top', (e.target as HTMLInputElement).value)"
        @change="onColorChange('top', ($event.target as HTMLInputElement).value)"
      />
    </div>
    <div class="field">
      <label>{{ colorLabels.horizon }}</label>
      <input
        type="color"
        :value="numToHex(node.horizonColor)"
        @input="(e) => onColorChange('horizon', (e.target as HTMLInputElement).value)"
        @change="onColorChange('horizon', ($event.target as HTMLInputElement).value)"
      />
    </div>
    <div class="field">
      <label>{{ colorLabels.ground }}</label>
      <input
        type="color"
        :value="numToHex(node.groundColor)"
        @input="(e) => onColorChange('ground', (e.target as HTMLInputElement).value)"
        @change="onColorChange('ground', ($event.target as HTMLInputElement).value)"
      />
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
</style>
