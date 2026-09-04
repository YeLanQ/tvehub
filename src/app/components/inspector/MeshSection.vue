<script setup lang="ts">
import { MeshNode } from "../../../framework/prototype/derived/Primitives";

defineProps<{ node: MeshNode }>();

const emit = defineEmits<{
  update: [label: string];
}>();

function numToHex(v: number): string {
  return "#" + (v & 0xffffff).toString(16).padStart(6, "0");
}
</script>

<template>
  <div class="section">
    <div class="section__title">Mesh</div>
    <div class="field-row">
      <label>Geometry</label>
      <select :value="node.geometry" @change="emit('update', 'Set Geometry')">
        <option value="box">Box</option>
        <option value="sphere">Sphere</option>
        <option value="cylinder">Cylinder</option>
        <option value="plane">Plane</option>
      </select>
    </div>
    <div class="field-row">
      <label>Color</label>
      <input
        type="text"
        :value="numToHex(node.color)"
        @change="emit('update', 'Set Color')"
      />
      <input type="color" :value="numToHex(node.color)" @change="emit('update', 'Set Color')" />
    </div>
    <div class="field-row">
      <label>Metalness</label>
      <input
        type="number"
        min="0"
        max="1"
        step="0.05"
        :value="node.metalness"
        @change="emit('update', 'Set Metalness')"
      />
    </div>
    <div class="field-row">
      <label>Roughness</label>
      <input
        type="number"
        min="0"
        max="1"
        step="0.05"
        :value="node.roughness"
        @change="emit('update', 'Set Roughness')"
      />
    </div>
  </div>
</template>