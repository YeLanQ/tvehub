<script setup lang="ts">
import { LightNode } from "../../../framework/prototype/derived/Primitives";

const props = defineProps<{ node: LightNode }>();

const emit = defineEmits<{
  update: [label: string];
}>();

function hexToNum(hex: string): number {
  const clean = hex.replace("#", "");
  const v = parseInt(clean.length === 3 ? clean.replace(/(.)/g, "$1$1") : clean, 16);
  return Number.isNaN(v) ? 0 : v;
}

function numToHex(v: number): string {
  return "#" + (v & 0xffffff).toString(16).padStart(6, "0");
}
</script>

<template>
  <div class="section">
    <div class="section__title">Light</div>
    <div class="field-row">
      <label>Kind</label>
      <select :value="node.lightKind" @change="emit('update', 'Set Light Kind')">
        <option value="point">Point</option>
        <option value="directional">Directional</option>
        <option value="ambient">Ambient</option>
      </select>
    </div>
    <div class="field-row">
      <label>Intensity</label>
      <input
        type="number"
        step="0.1"
        min="0"
        :value="node.intensity"
        @change="emit('update', 'Set Intensity')"
      />
    </div>
    <div class="field-row">
      <label>Color</label>
      <input
        type="text"
        :value="numToHex(node.lightColor)"
        @change="emit('update', 'Set Light Color')"
      />
    </div>
    <div class="field-row">
      <label>Shadow</label>
      <input
        type="checkbox"
        :checked="node.castShadow"
        @change="emit('update', 'Toggle Shadow')"
      />
    </div>
  </div>
</template>