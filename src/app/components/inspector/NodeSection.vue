<script setup lang="ts">
import { ref, watch } from "vue";
import type { Node } from "../../../framework/prototype/Node";

const props = defineProps<{ node: Node }>();

const emit = defineEmits<{
  rename: [name: string];
  toggleActive: [value: boolean];
  toggleVisible: [value: boolean];
}>();

const localName = ref("");

watch(
  () => props.node.id,
  () => {
    localName.value = props.node.name;
  },
  { immediate: true }
);

function commitName(): void {
  if (localName.value !== props.node.name) {
    emit("rename", localName.value);
  }
}
</script>

<template>
  <div class="section">
    <div class="section__title">Node</div>
    <div class="field-row">
      <label>Name</label>
      <input v-model="localName" type="text" @change="commitName" />
    </div>
    <div class="field-row">
      <span class="type-tag">{{ node.typeKey }}</span>
      <span class="muted mono">{{ node.id }}</span>
    </div>
    <div class="field-row">
      <label>Active</label>
      <input
        type="checkbox"
        :checked="node.active"
        @change="emit('toggleActive', ($event.target as HTMLInputElement).checked)"
      />
      <label class="inline">Visible</label>
      <input
        type="checkbox"
        :checked="node.visible"
        @change="emit('toggleVisible', ($event.target as HTMLInputElement).checked)"
      />
    </div>
  </div>
</template>