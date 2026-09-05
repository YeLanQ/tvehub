<script setup lang="ts">
import { CameraNode } from "../../../framework/prototype/derived/Primitives";
import NumberField from "../NumberField.vue";

defineProps<{ node: CameraNode; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();
</script>

<template>
  <div class="field" :data-rev="rev">
    <label>Fov</label>
    <NumberField
      :model-value="node.fov"
      :step="1"
      title="Fov"
      @commit="(v) => emit('update', 'Set Fov', v)"
    />
  </div>
  <div class="field">
    <label>Near</label>
    <NumberField
      :model-value="node.near"
      :step="0.001"
      :min="0.01"
      title="Near"
      @commit="(v) => emit('update', 'Set Near', v)"
    />
  </div>
  <div class="field">
    <label>Far</label>
    <NumberField
      :model-value="node.far"
      :step="0.5"
      :min="1"
      title="Far"
      @commit="(v) => emit('update', 'Set Far', v)"
    />
  </div>
</template>
