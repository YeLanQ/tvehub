<script setup lang="ts">
// ---------------------------------------------------------------------------
// 动画剪辑概览块（展示型，从 AssetInspector 抽出）：时长（含循环/单次）+ 通道数 +
// 绑定说明。概览由父组件读取 .anim 文本后传入（读取中/失败为 null，显示占位）。
// ---------------------------------------------------------------------------
defineProps<{
  /** 动画剪辑概览（读取中/失败为 null） */
  info: { duration: number; loops: boolean; curves: number } | null;
}>();
</script>

<template>
  <template v-if="info">
    <div class="field">
      <label>时长</label>
      <span>{{ info.duration.toFixed(2) }}s {{ info.loops ? "（循环）" : "（单次）" }}</span>
    </div>
    <div class="field">
      <label>通道数</label>
      <span>{{ info.curves }}</span>
    </div>
  </template>
  <div v-else class="hint">读取中…</div>
  <div class="hint">给节点添加「动画剪辑」组件并绑定本剪辑，预览/发布即自动播放。</div>
</template>
