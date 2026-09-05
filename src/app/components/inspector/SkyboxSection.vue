<script setup lang="ts">
import { computed } from "vue";
import { SkyboxNode, type SkyboxKind } from "../../../framework/prototype/derived/Primitives";

const props = defineProps<{ node: SkyboxNode; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

const kindLabel = computed(() =>
  props.node.skyKind === "procedural" ? "程序化天空盒" : "默认立方体天空盒",
);

/** 程序化天空 / 立方体天空盒的色项标签（同字段、不同语义命名） */
const colorLabels = computed<{ top: string; horizon: string; ground: string }>(() =>
  props.node.skyKind === "procedural"
    ? { top: "天空顶部色", horizon: "地平线色", ground: "下方地面色" }
    : { top: "顶面颜色", horizon: "侧面颜色", ground: "底面颜色" },
);

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

function onKindChange(kind: SkyboxKind): void {
  emit("update", "Set Sky Kind", kind);
}
</script>

<template>
  <div :data-rev="rev">
    <div class="field">
      <label>类型</label>
      <select
        class="sky-kind-select"
        :value="node.skyKind"
        @change="onKindChange(($event.target as HTMLSelectElement).value as SkyboxKind)"
      >
        <option value="procedural">程序化天空盒</option>
        <option value="cube">默认立方体天空盒</option>
      </select>
    </div>

    <div class="sky-kind mono">
      <span class="light-kind-tag">{{ kindLabel }}</span>
      <span class="hint-inline">第一个启用的天空盒节点作为场景背景</span>
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
