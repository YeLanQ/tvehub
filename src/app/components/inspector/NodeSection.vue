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
/** 名称输入框是否正在编辑（编辑中不做外部回填，避免打断输入） */
const editingName = ref(false);

watch(
  () => props.node.id,
  () => {
    localName.value = props.node.name;
  },
  { immediate: true }
);

// 节点是普通类实例（非响应式），直接 watch node.name 永远不会触发；
// 以 rev（面板刷新号）为信号回填：重命名/撤销/重做后输入框跟随节点名
watch(
  () => props.rev,
  () => {
    if (!editingName.value && localName.value !== props.node.name) {
      localName.value = props.node.name;
    }
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
    <input
      v-model="localName"
      type="text"
      @focus="editingName = true"
      @blur="editingName = false"
      @change="commitName"
    />
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
