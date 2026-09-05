<script setup lang="ts">
import type { GeometryKind } from "../../../framework/prototype/derived/Primitives";
import { MeshNode } from "../../../framework/prototype/derived/Primitives";
import NumberField from "../NumberField.vue";

defineProps<{ node: MeshNode; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

function numToHex(v: number): string {
  return "#" + (v & 0xffffff).toString(16).padStart(6, "0");
}

function onColorHex(hex: string): void {
  const n = parseInt(hex.replace("#", ""), 16);
  if (Number.isNaN(n)) return;
  emit("update", "Set Color", n);
}

function onGeometryChange(e: Event): void {
  const value = (e.target as HTMLSelectElement).value as GeometryKind;
  emit("update", "Set Geometry", value);
}
</script>

<template>
  <div class="field" :data-rev="rev">
    <label>Geometry</label>
    <select :value="node.geometry" @change="onGeometryChange($event)">
      <option value="box">Box</option>
      <option value="sphere">Sphere</option>
      <option value="cylinder">Cylinder</option>
      <option value="plane">Plane</option>
    </select>
  </div>
  <div class="field">
    <label>Color</label>
    <input type="color" :value="numToHex(node.color)" @change="onColorHex(($event.target as HTMLInputElement).value)" />
  </div>
  <div class="field">
    <label>Metalness</label>
    <NumberField
      :model-value="node.metalness"
      :step="0.05"
      title="Metalness"
      @commit="(v) => emit('update', 'Set Metalness', v)"
    />
  </div>
  <div class="field">
    <label>Roughness</label>
    <NumberField
      :model-value="node.roughness"
      :step="0.05"
      title="Roughness"
      @commit="(v) => emit('update', 'Set Roughness', v)"
    />
  </div>
</template>
