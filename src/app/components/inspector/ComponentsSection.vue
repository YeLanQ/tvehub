<script setup lang="ts">
import { ref } from "vue";
import type { Node } from "../../../framework/prototype/Node";
import { MeshNode, LightNode, CameraNode } from "../../../framework/prototype/derived/Primitives";

const props = defineProps<{ node: Node }>();

const emit = defineEmits<{
  addComponent: [type: string];
  removeComponent: [type: string];
}>();

const compAddOpen = ref(false);

function hasComponent(type: string): boolean {
  if (type === "wireframe" && props.node instanceof MeshNode) {
    return props.node.wireframe;
  }
  return false;
}
</script>

<template>
  <div class="section">
    <div class="section__title">Components</div>
    <div class="comp-list">
      <div v-if="node instanceof MeshNode" class="comp-row">
        <span class="comp-label">Mesh Renderer</span>
        <span class="comp-type mono">Mesh</span>
      </div>
      <div v-if="hasComponent('wireframe')" class="comp-row">
        <span class="comp-label">Wireframe</span>
        <span class="comp-type mono">Render</span>
        <button class="comp-remove" title="移除组件" @click="emit('removeComponent', 'wireframe')">✕</button>
      </div>
      <div v-if="node instanceof LightNode" class="comp-row">
        <span class="comp-label">Light</span>
        <span class="comp-type mono">Light</span>
      </div>
      <div v-if="node instanceof CameraNode" class="comp-row">
        <span class="comp-label">Camera</span>
        <span class="comp-type mono">Camera</span>
      </div>
    </div>
    <button class="add-comp-btn" @click.stop="compAddOpen = !compAddOpen">＋ 添加组件</button>
    <div v-if="compAddOpen" class="add-comp-menu">
      <div v-if="node instanceof MeshNode" class="add-comp-item" @click="emit('addComponent', 'wireframe')">
        <span>Wireframe</span>
        <span class="mono comp-type">Render</span>
      </div>
      <div v-if="node instanceof MeshNode" class="hint add-comp-empty">仅网格节点可添加组件</div>
    </div>
  </div>
</template>