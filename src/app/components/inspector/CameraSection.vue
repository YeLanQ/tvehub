<script setup lang="ts">
import { CameraNode } from "../../../framework/prototype/derived/Primitives";
import NumberField from "../NumberField.vue";

defineProps<{ node: CameraNode }>();

const emit = defineEmits<{
  update: [label: string];
}>();
</script>

<template>
  <div class="field">
    <label>Fov</label>
    <NumberField
      :model-value="node.fov"
      :step="1"
      title="Fov"
      @commit="() => emit('update', 'Set Fov')"
    />
  </div>
  <div class="field">
    <label>Near</label>
    <NumberField
      :model-value="node.near"
      :step="0.001"
      title="Near"
      @commit="() => emit('update', 'Set Near')"
    />
  </div>
  <div class="field">
    <label>Far</label>
    <NumberField
      :model-value="node.far"
      :step="0.5"
      title="Far"
      @commit="() => emit('update', 'Set Far')"
    />
  </div>
</template>
