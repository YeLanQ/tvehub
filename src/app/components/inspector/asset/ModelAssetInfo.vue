<script setup lang="ts">
// ---------------------------------------------------------------------------
// 模型信息块（展示型，从 AssetInspector 抽出）：动画剪辑数 / 内嵌材质数 / 骨骼。
// 概览由父组件从引擎模型缓存（metaFor）读取后传入，本组件只读展示；
// 是否模型资产由父组件按 MODEL_KINDS 判定后再渲染本组件。
// ---------------------------------------------------------------------------
defineProps<{
  /** 模型概览（父组件读取就绪后渲染本组件） */
  info: { clips: number; materials: number; hasSkeleton: boolean };
}>();
</script>

<template>
  <div class="field">
    <label>动画剪辑</label>
    <span class="muted">{{ info.clips }} 个</span>
  </div>
  <div class="field">
    <label>内嵌材质</label>
    <span class="muted">{{ info.materials }} 个</span>
  </div>
  <div class="field">
    <label>骨骼</label>
    <span class="muted">{{ info.hasSkeleton ? "有" : "无" }}</span>
  </div>
</template>
