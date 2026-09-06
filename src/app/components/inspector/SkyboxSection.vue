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
import NumberField from "../NumberField.vue";

const props = defineProps<{ node: SkyboxNode; rev?: number }>();

const emit = defineEmits<{
  setMaterial: [rel: string];
  copyToProject: [];
  update: [label: string, value: unknown];
}>();

const assetsStore = getAssetsStore();

/** 材质资产选项（与 Material 卡片共用；内置 + 项目全部 .mat） */
const options = useMaterialAssetOptions(() => assetsStore.assets);

/** 当前类型（固定）。节点是普通类实例（非响应式）：以 rev 为失效信号 */
const kindLabel = computed(() => {
  void props.rev;
  return props.node.skyKind === "procedural" ? "程序化天空盒" : "默认立方体天空盒";
});

/** 程序化 / 立方体的色项标签（同字段、不同语义命名） */
const colorLabels = computed<{ top: string; horizon: string; ground: string }>(() => {
  void props.rev;
  return props.node.skyKind === "procedural"
    ? { top: "天空顶部色", horizon: "地平线色", ground: "下方地面色" }
    : { top: "顶面颜色", horizon: "侧面颜色", ground: "底面颜色" };
});

const isInternal = computed(() => {
  // 切换/复制材质资产后徽标需跟随（node.material 原地修改，靠 rev 失效）
  void props.rev;
  return isInternalAsset(props.node.material);
});

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

function onSunDiskChange(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  emit("update", "Set Sun Disk", v);
}

function onSunColorChange(e: Event): void {
  const hex = (e.target as HTMLInputElement).value;
  emit("update", "Set Sun Color", hexToNum(hex));
}

function onSunNumber(label: string, v: number): void {
  emit("update", label, v);
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

    <!-- 程序化天空专属：太阳参数 -->
    <template v-if="node.skyKind === 'procedural'">
      <div class="sky-sun-head">太阳</div>
      <div class="field">
        <label>太阳盘</label>
        <select :value="node.sunDisk" @change="onSunDiskChange">
          <option value="high">高精度（光晕）</option>
          <option value="simple">简化（纯亮盘）</option>
          <option value="none">无</option>
        </select>
      </div>
      <div class="field">
        <label>太阳颜色</label>
        <input
          type="color"
          :value="numToHex(node.sunColor)"
          @input="onSunColorChange"
          @change="onSunColorChange"
        />
      </div>
      <div class="field">
        <label>太阳大小</label>
        <NumberField
          :model-value="node.sunSize"
          :step="0.5"
          :min="0.2"
          :max="30"
          title="太阳盘半径（度）"
          @commit="(v) => onSunNumber('Set Sun Size', v)"
        />
      </div>
      <div class="field">
        <label>光晕强度</label>
        <NumberField
          :model-value="node.sunGlow"
          :step="0.05"
          :min="0"
          :max="1"
          title="光晕强度（0~1；颜色与太阳颜色一致）"
          @commit="(v) => onSunNumber('Set Sun Glow', v)"
        />
      </div>
      <div class="field">
        <label>方位角</label>
        <NumberField
          :model-value="node.sunAzimuth"
          :step="5"
          :min="0"
          :max="360"
          title="太阳方位角（度，0 = +X）"
          @commit="(v) => onSunNumber('Set Sun Azimuth', v)"
        />
      </div>
      <div class="field">
        <label>仰角</label>
        <NumberField
          :model-value="node.sunElevation"
          :step="1"
          :min="0"
          :max="360"
          title="太阳仰角（度：0=地平线，90=天顶，180=对侧地平线，270=正下方，360=回到地平线）"
          @commit="(v) => onSunNumber('Set Sun Elevation', v)"
        />
      </div>
    </template>
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
.sky-sun-head {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dim, #999);
  border-top: 1px solid var(--border, #333);
  padding: 6px 0 2px;
  margin-top: 4px;
}
</style>
