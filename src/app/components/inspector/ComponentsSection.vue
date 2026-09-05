<script setup lang="ts">
import type { Node } from "../../../framework/prototype/Node";
import { MeshNode, LightNode, CameraNode } from "../../../framework/prototype/derived/Primitives";

defineProps<{ node: Node; rev?: number }>();
</script>

<template>
  <div class="comp-list" :data-rev="rev">
    <div v-if="node instanceof MeshNode" class="comp-row">
      <span class="comp-label">Mesh Renderer</span>
      <span class="comp-type mono">Mesh</span>
    </div>
    <div v-if="node instanceof MeshNode" class="comp-row">
      <span class="comp-label">Material</span>
      <span class="comp-type mono">Mat</span>
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
  <div class="hint add-comp-empty">线框已并入材质参数（Material 卡片），修改会写入材质资产</div>
</template>
