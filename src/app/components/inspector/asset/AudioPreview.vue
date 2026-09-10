<script setup lang="ts">
// ---------------------------------------------------------------------------
// 音频资产预览块（展示型，从 AssetInspector 抽出）：原生播放器 + 绑定说明。
// 无状态无交互上抛；是否音频资产由父组件按 isAudioAssetRel 判定后再渲染本组件。
// ---------------------------------------------------------------------------
import { assetUrl } from "../../../../lib/asset-url";

defineProps<{
  /** 资产相对路径（asset:// 取数） */
  rel: string;
}>();
</script>

<template>
  <div class="asset-audio-wrap">
    <audio controls preload="metadata" :src="assetUrl(rel)" />
  </div>
  <div class="hint">音频资产：添加「Audio Source」音源节点后在此绑定播放；2D 全局 / 3D 位置衰减。</div>
</template>

<style scoped>
.asset-audio-wrap {
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  padding: 8px;
  display: flex;
  align-items: center;
  margin-bottom: 2px;
}
.asset-audio-wrap audio {
  width: 100%;
  height: 36px;
}
</style>
