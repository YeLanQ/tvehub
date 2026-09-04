<script setup lang="ts">
import type { Node } from "../../../framework/prototype/Node";
import NumberField from "../NumberField.vue";

defineProps<{ node: Node }>();

const emit = defineEmits<{
  transform: [axis: "position" | "rotation" | "scale", part: "x" | "y" | "z", value: number];
}>();

function onCommit(axis: "position" | "rotation" | "scale", part: "x" | "y" | "z", value: number): void {
  emit("transform", axis, part, value);
}
</script>

<template>
  <div v-for="axis in ['position', 'rotation', 'scale'] as const" :key="axis" class="vec3">
    <span class="v-label">{{ axis }}</span>
    <NumberField
      v-for="p in ['x', 'y', 'z'] as const"
      :key="p"
      :title="`${p}`"
      :model-value="node.transform[axis][p]"
      :step="axis === 'rotation' ? 0.25 : 0.01"
      @commit="(v) => onCommit(axis, p, v)"
    />
  </div>
</template>
