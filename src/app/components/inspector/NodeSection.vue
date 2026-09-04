<script setup lang="ts">
import { ref, watch } from "vue";
import type { Node } from "../../../framework/prototype/Node";

const props = defineProps<{ node: Node; rev?: number }>();

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

watch(
  () => props.node.name,
  (v) => {
    if (localName.value !== v) localName.value = v;
  }
);

function commitName(): void {
  if (localName.value !== props.node.name) {
    emit("rename", localName.value);
  }
}
</script>

<template>
  <div class="field" :data-rev="rev">
    <label>名称</label>
    <input v-model="localName" type="text" @change="commitName" />
  </div>
  <div class="field">
    <label>ID</label>
    <span class="mono">{{ node.id }}</span>
  </div>
  <div class="field">
    <label>子节点</label>
    <span>{{ node.childIds.length }}</span>
  </div>
  <div class="field">
    <label>可见</label>
    <input
      type="checkbox"
      :checked="node.visible"
      @change="emit('toggleVisible', ($event.target as HTMLInputElement).checked)"
    />
  </div>
</template>
