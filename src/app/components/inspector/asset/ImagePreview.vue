<script setup lang="ts">
// ---------------------------------------------------------------------------
// 纹理资产原图预览块（展示型，从 AssetInspector 抽出）：原图 + 尺寸行。
// 尺寸状态由父组件持有（切换资产时重置），本组件只在图片载入完成时上抛自然宽高，
// 自身不缓存任何加载状态。
// ---------------------------------------------------------------------------
import { assetUrl } from "../../../../lib/asset-url";

defineProps<{
  /** 资产相对路径（asset:// 取数） */
  rel: string;
  /** 显示名（img alt） */
  name: string;
  /** 原图自然尺寸（未载入为 null，此时不显示尺寸行） */
  size: { w: number; h: number } | null;
}>();

const emit = defineEmits<{
  /** 原图载入完成（自然宽高） */
  loaded: [w: number, h: number];
}>();

function onImgLoad(e: Event): void {
  const img = e.target as HTMLImageElement;
  emit("loaded", img.naturalWidth, img.naturalHeight);
}
</script>

<template>
  <div class="asset-img-wrap">
    <img :src="assetUrl(rel)" :alt="name" @load="onImgLoad" />
  </div>
  <div v-if="size" class="field">
    <label>尺寸</label>
    <span class="muted">{{ size.w }} × {{ size.h }}</span>
  </div>
</template>

<style scoped>
.asset-img-wrap {
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  overflow: hidden;
  background:
    repeating-conic-gradient(#242428 0% 25%, #2e2e33 0% 50%) 0 0 / 16px 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  margin-bottom: 2px;
}
.asset-img-wrap img {
  max-width: 100%;
  max-height: 220px;
  object-fit: contain;
  display: block;
}
</style>
