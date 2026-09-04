<script setup lang="ts">
import { CameraNode } from "../../../framework/prototype/derived/Primitives";

defineProps<{ node: CameraNode }>();

const emit = defineEmits<{
  update: [label: string];
}>();
</script>

<template>
  <div class="section">
    <div class="section__title">Camera</div>
    <div class="field-row">
      <label>Fov</label>
      <input
        type="number"
        step="1"
        :value="node.fov"
        @change="emit('update', 'Set Fov')"
      />
    </div>
    <div class="field-row">
      <label>Near</label>
      <input
        type="number"
        step="0.1"
        :value="node.near"
        @change="emit('update', 'Set Near')"
      />
    </div>
    <div class="field-row">
      <label>Far</label>
      <input
        type="number"
        :value="node.far"
        @change="emit('update', 'Set Far')"
      />
    </div>
  </div>
</template>