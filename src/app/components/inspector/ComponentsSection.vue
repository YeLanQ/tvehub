<script setup lang="ts">
import { computed } from "vue";
import type { Node } from "../../../framework/prototype/Node";
import { MeshNode, LightNode, CameraNode, SkyboxNode } from "../../../framework/prototype/derived/Primitives";
import { getEditorStore } from "../../stores/editor";

const props = defineProps<{ node: Node; rev?: number }>();

/** 模型解析信息（蒙皮/剪辑；随 model:changed 的 rev 刷新） */
const modelMeta = computed(() => {
  void props.rev;
  const engine = getEditorStore().engine;
  const n = props.node;
  return n instanceof MeshNode && n.source === "model" && n.model
    ? engine.models.metaFor(n.model)
    : null;
});
</script>

<template>
  <div class="comp-list" :data-rev="rev">
    <div v-if="node instanceof MeshNode" class="comp-row">
      <span class="comp-label">{{
        node.source === "model" ? "Model Renderer" : "Mesh Renderer"
      }}</span>
      <span class="comp-type mono">{{
        node.source === "model" ? "Model" : "Mesh"
      }}</span>
    </div>
    <div v-if="node instanceof MeshNode && node.source === 'primitive'" class="comp-row">
      <span class="comp-label">Material</span>
      <span class="comp-type mono">Mat</span>
    </div>
    <div v-else-if="modelMeta && modelMeta.materials.length > 0" class="comp-row">
      <span class="comp-label">Material</span>
      <span class="comp-type mono">内嵌 × {{ modelMeta.materials.length }}</span>
    </div>
    <div v-if="modelMeta?.hasSkeleton" class="comp-row">
      <span class="comp-label">Skinned Mesh</span>
      <span class="comp-type mono">骨骼</span>
    </div>
    <div v-if="modelMeta && modelMeta.clips.length > 0" class="comp-row">
      <span class="comp-label">Animation</span>
      <span class="comp-type mono">{{
        node instanceof MeshNode && node.animGraph ? `图 · ${node.animGraph.states.length} 态` : `${modelMeta.clips.length} 剪辑`
      }}</span>
    </div>
    <div v-if="node instanceof LightNode" class="comp-row">
      <span class="comp-label">Light</span>
      <span class="comp-type mono">Light</span>
    </div>
    <div v-if="node instanceof CameraNode" class="comp-row">
      <span class="comp-label">Camera</span>
      <span class="comp-type mono">{{ node.cameraType === "orthographic" ? "Ortho" : "Persp" }}</span>
    </div>
    <div v-if="node instanceof SkyboxNode" class="comp-row">
      <span class="comp-label">Skybox</span>
      <span class="comp-type mono">Sky</span>
    </div>
  </div>
  <div v-if="node instanceof MeshNode && node.source === 'model'" class="hint add-comp-empty">
    模型网格的几何/材质由模型资产提供；动画经 Animation 卡片配置
  </div>
  <div v-else-if="node instanceof MeshNode" class="hint add-comp-empty">
    线框已并入材质参数（Material 卡片），修改会写入材质资产
  </div>
  <div v-else class="hint add-comp-empty">
    组件随节点类型自动创建（Mesh / Light / Camera / Skybox）
  </div>
</template>
