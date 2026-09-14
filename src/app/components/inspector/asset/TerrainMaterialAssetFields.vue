<script setup lang="ts">
// ---------------------------------------------------------------------------
// 地形材质资产块（可编辑，从 AssetInspector 拆出）：
// 图层数 + 每层配色/平铺/PBR + splatmap 引用 + 全局 PBR。
// 编辑后防抖写回 .terrainmat 文件（api.terrainmatWrite）。
// ---------------------------------------------------------------------------

import { ref, watch } from "vue";
import { getProjectStore } from "../../../stores/project";
import { getEditorStore } from "../../../stores/editor";
import { logStore } from "../../../stores/log";
import { api } from "../../../../lib/api";
import {
  TERRAIN_MATERIAL_LIMITS,
  cloneTerrainMaterialSettings,
  type TerrainMaterialSettings,
} from "../../../../framework/terrain";
import { TerrainNode } from "../../../../framework/prototype/derived/Primitives";
import { dispatchCommand } from "../../../commands";
import type { JsonRecord } from "../../../../framework/prototype/types";
import NumberField from "../../NumberField.vue";

const props = defineProps<{
  /** 地形材质设置（读取中/失败为 null） */
  settings: TerrainMaterialSettings | null;
  /** 资产相对路径（用于保存） */
  rel: string;
  /** 内置只读资产 */
  readonly?: boolean;
}>();

const projectStore = getProjectStore();
const L = TERRAIN_MATERIAL_LIMITS;
const layerLabels = ["R", "G", "B", "A"];

/** 本地可编辑副本 */
const local = ref<TerrainMaterialSettings | null>(null);

/** 外部 settings 变化时同步到本地（切换资产/首次加载） */
watch(
  () => props.settings,
  (v) => { local.value = v ? { ...v, layers: v.layers.map((l) => ({ ...l })) } as TerrainMaterialSettings : null; },
  { immediate: true },
);

/** 防抖保存 */
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(): void {
  if (props.readonly || !local.value) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void doSave(), 400);
}

async function doSave(): Promise<void> {
  const root = projectStore.currentPath;
  if (!root || !local.value || props.readonly) return;
  const rel = props.rel;
  const stem = rel.slice(rel.lastIndexOf("/") + 1, rel.length - ".terrainmat".length);
  try {
    await api.terrainmatWrite(root, rel, stem, local.value as unknown as Record<string, unknown>);
    logStore.log("success", `已保存地形材质: ${rel}`);
    // 同步更新引用此材质的地形节点快照（否则视口不刷新）
    const editor = getEditorStore();
    for (const n of editor.nodes()) {
      if (n instanceof TerrainNode && n.materialAsset === rel) {
        const before = n.toJSON() as JsonRecord;
        n.materialSettings = cloneTerrainMaterialSettings(local.value);
        const after = n.toJSON() as JsonRecord;
        void dispatchCommand("node.patch", { id: n.id, before, after, label: "更新地形材质" });
      }
    }
  } catch (e) {
    logStore.log("error", `保存地形材质失败: ${e}`);
  }
}

function numToHex(v: number): string {
  return "#" + (v & 0xffffff).toString(16).padStart(6, "0");
}
function hexToNum(hex: string): number {
  return parseInt(hex.replace("#", ""), 16) & 0xffffff;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function onLayerColor(i: number, e: Event): void {
  if (!local.value) return;
  local.value.layers[i].color = hexToNum((e.target as HTMLInputElement).value);
  scheduleSave();
}
function onLayerTiling(i: number, v: number): void {
  if (!local.value) return;
  local.value.layers[i].tiling = clamp(v, L.tiling.min, L.tiling.max);
  scheduleSave();
}
function onLayerMetalness(i: number, v: number): void {
  if (!local.value) return;
  local.value.layers[i].metalness = clamp(v, L.metalness.min, L.metalness.max);
  scheduleSave();
}
function onLayerRoughness(i: number, v: number): void {
  if (!local.value) return;
  local.value.layers[i].roughness = clamp(v, L.roughness.min, L.roughness.max);
  scheduleSave();
}
function onLayerCount(v: number): void {
  if (!local.value) return;
  local.value.layerCount = clamp(Math.round(v), L.layerCount.min, L.layerCount.max);
  scheduleSave();
}
function onGlobalMetalness(v: number): void {
  if (!local.value) return;
  local.value.metalness = clamp(v, L.metalness.min, L.metalness.max);
  scheduleSave();
}
function onGlobalRoughness(v: number): void {
  if (!local.value) return;
  local.value.roughness = clamp(v, L.roughness.min, L.roughness.max);
  scheduleSave();
}
function onSplatmap(e: Event): void {
  if (!local.value) return;
  local.value.splatmap = (e.target as HTMLInputElement).value;
  scheduleSave();
}
</script>

<template>
  <template v-if="local">
    <!-- ===== Layers ===== -->
    <div class="ts-group">Layers</div>
    <div class="field">
      <label title="激活图层数（1-4；对应 splatmap RGBA 通道）">Count</label>
      <NumberField
        :model-value="local.layerCount"
        :step="1"
        :min="L.layerCount.min"
        :max="L.layerCount.max"
        :disabled="readonly"
        title="激活图层数"
        @commit="onLayerCount"
      />
    </div>
    <div
      v-for="i in local.layerCount"
      :key="i"
      class="ts-layer"
    >
      <div class="ts-layer-head">
        <span class="ts-ch">{{ layerLabels[i - 1] }}</span>
        <span class="ts-layer-title">Layer {{ i - 1 }}</span>
      </div>
      <div class="field">
        <label>Color</label>
        <input
          type="color"
          :value="numToHex(local.layers[i - 1].color)"
          :disabled="readonly"
          @change="onLayerColor(i - 1, $event)"
        />
      </div>
      <div class="field">
        <label>Tiling</label>
        <NumberField
          :model-value="local.layers[i - 1].tiling"
          :step="0.5"
          :min="L.tiling.min"
          :max="L.tiling.max"
          :disabled="readonly"
          @commit="(v) => onLayerTiling(i - 1, v)"
        />
      </div>
      <div class="field">
        <label>Metalness</label>
        <NumberField
          :model-value="local.layers[i - 1].metalness"
          :step="0.05"
          :min="L.metalness.min"
          :max="L.metalness.max"
          :disabled="readonly"
          @commit="(v) => onLayerMetalness(i - 1, v)"
        />
      </div>
      <div class="field">
        <label>Roughness</label>
        <NumberField
          :model-value="local.layers[i - 1].roughness"
          :step="0.05"
          :min="L.roughness.min"
          :max="L.roughness.max"
          :disabled="readonly"
          @commit="(v) => onLayerRoughness(i - 1, v)"
        />
      </div>
    </div>

    <!-- ===== Splatmap ===== -->
    <div class="ts-group">Splatmap</div>
    <div class="field">
      <label title="Splatmap 纹理资产路径（空 = 使用地形内置顶点色）">Map</label>
      <input
        type="text"
        :value="local.splatmap"
        :disabled="readonly"
        placeholder="内置顶点色"
        @change="onSplatmap"
      />
    </div>

    <!-- ===== Global PBR ===== -->
    <div class="ts-group">Global PBR</div>
    <div class="field">
      <label>Metalness</label>
      <NumberField
        :model-value="local.metalness"
        :step="0.05"
        :min="L.metalness.min"
        :max="L.metalness.max"
        :disabled="readonly"
        @commit="onGlobalMetalness"
      />
    </div>
    <div class="field">
      <label>Roughness</label>
      <NumberField
        :model-value="local.roughness"
        :step="0.05"
        :min="L.roughness.min"
        :max="L.roughness.max"
        :disabled="readonly"
        @commit="onGlobalRoughness"
      />
    </div>
    <div class="hint">
      {{ readonly ? "内置资产只读：可「复制到项目」后使用。" : "编辑后自动保存。由地形节点检查器绑定到地形。" }}
    </div>
  </template>
  <div v-else class="hint">读取中…</div>
</template>

<style scoped>
.ts-group {
  margin: 8px 0 2px;
  padding-top: 4px;
  font-size: 10px;
  letter-spacing: 0.4px;
  color: var(--text-dim, #999);
  border-top: 1px solid var(--border, #333);
}
.ts-layer {
  margin: 4px 0;
  padding: 4px 0;
  border-top: 1px solid var(--border, #2a2a2a);
}
.ts-layer-head {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 2px;
}
.ts-ch {
  font-size: 10px;
  font-weight: 600;
  color: var(--accent, #4a9eff);
  width: 12px;
}
.ts-layer-title {
  font-size: 10px;
  color: var(--text-dim, #999);
}
</style>
