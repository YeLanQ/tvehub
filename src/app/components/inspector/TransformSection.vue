<script setup lang="ts">
import type { Node } from "../../../framework/prototype/Node";
import type { TransformSnapshot } from "../../../framework/command/commands";

const props = defineProps<{ node: Node }>();

const emit = defineEmits<{
  transform: [axis: "position" | "rotation" | "scale", part: "x" | "y" | "z", value: number];
}>();

function num(v: number, digits = 3): number {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

function onChange(axis: "position" | "rotation" | "scale", part: "x" | "y" | "z", e: Event): void {
  const target = e.target as HTMLInputElement;
  emit("transform", axis, part, parseFloat(target.value) || 0);
}
</script>

<template>
  <div class="section">
    <div class="section__title">Transform</div>
    <div v-for="axis in ['position', 'rotation', 'scale'] as const" :key="axis" class="vec3">
      <span class="v-label">{{ axis }}</span>
      <input
        v-for="p in ['x', 'y', 'z'] as const"
        :key="p"
        type="number"
        step="0.1"
        :value="num(node.transform[axis][p])"
        @change="onChange(axis, p, $event)"
      />
    </div>
  </div>
</template>