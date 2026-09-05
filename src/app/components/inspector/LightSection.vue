<script setup lang="ts">
import { LightNode } from "../../../framework/prototype/derived/Primitives";
import NumberField from "../NumberField.vue";

defineProps<{ node: LightNode; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

function numToHex(v: number): string {
  return "#" + (v & 0xffffff).toString(16).padStart(6, "0");
}

function onColorHex(hex: string): void {
  const n = parseInt(hex.replace("#", ""), 16);
  if (Number.isNaN(n)) return;
  emit("update", "Set Light Color", n);
}

function onKindChange(e: Event): void {
  const value = (e.target as HTMLSelectElement).value as LightNode["lightKind"];
  emit("update", "Set Light Kind", value);
}

function onShadowChange(e: Event): void {
  const checked = (e.target as HTMLInputElement).checked;
  emit("update", "Toggle Shadow", checked);
}
</script>

<template>
  <div class="field" :data-rev="rev">
    <label>Kind</label>
    <select :value="node.lightKind" @change="onKindChange($event)">
      <option value="point">Point</option>
      <option value="directional">Directional</option>
      <option value="ambient">Ambient</option>
    </select>
  </div>
  <div class="field">
    <label>Intensity</label>
    <NumberField
      :model-value="node.intensity"
      :step="0.1"
      title="Intensity"
      @commit="(v) => emit('update', 'Set Intensity', v)"
    />
  </div>
  <div class="field">
    <label>Color</label>
    <input type="color" :value="numToHex(node.lightColor)" @change="onColorHex(($event.target as HTMLInputElement).value)" />
  </div>
  <div class="field">
    <label>Shadow</label>
    <input
      type="checkbox"
      :checked="node.castShadow"
      @change="onShadowChange($event)"
    />
  </div>
</template>
