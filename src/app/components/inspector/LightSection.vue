<script setup lang="ts">
import { LightNode } from "../../../framework/prototype/derived/Primitives";
import NumberField from "../NumberField.vue";

defineProps<{ node: LightNode }>();

const emit = defineEmits<{
  update: [label: string];
}>();

function numToHex(v: number): string {
  return "#" + (v & 0xffffff).toString(16).padStart(6, "0");
}

function onColorHex(hex: string): void {
  const n = parseInt(hex.replace("#", ""), 16);
  if (Number.isNaN(n)) return;
  emit("update", "Set Light Color");
}
</script>

<template>
  <div class="field">
    <label>Kind</label>
    <select :value="node.lightKind" @change="emit('update', 'Set Light Kind')">
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
      @commit="() => emit('update', 'Set Intensity')"
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
      @change="emit('update', 'Toggle Shadow')"
    />
  </div>
</template>
