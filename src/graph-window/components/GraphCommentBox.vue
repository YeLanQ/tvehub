<script setup lang="ts">
/**
 * 注释框（Vue Flow 自定义节点，经 #node-gcomment 插槽挂载）：
 * 半透明底 + 主题色边条的便签矩形；文本/颜色在右侧检查器编辑。
 * 尺寸完全由库管理（与 Uixder 同套路）：初始 = Node.width/height 字段，
 * 拖动缩放由 NodeResizer 写 node.style（优先级高于字段），内容 100% 填充
 * wrapper——业务数据不在拖动中逐帧同步，只在 resize-end 回写 c.w/c.h
 * （复制粘贴/撤销重建读该字段）。控件视觉隐藏（CSS），仅留拖拽热区。
 */
import { computed } from "vue";
import { NodeResizer } from "@vue-flow/node-resizer";
import type { GComment } from "../../framework/graph";
import { getGraphWindowStore } from "../graphStore";

const props = defineProps<{ id: string; data: { c: GComment }; selected?: boolean }>();

const store = getGraphWindowStore();
const c = computed(() => props.data.c);

function hexToRgba(hex: string, alpha: number): string {
  const n = hex.replace("#", "");
  const r = parseInt(n.slice(0, 2), 16) || 0;
  const g = parseInt(n.slice(2, 4), 16) || 0;
  const b = parseInt(n.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 缩放结束：最终尺寸回写持久化字段（载荷 { event, params:{width,height} }） */
function onResizeEnd(e: unknown): void {
  const p = (e as { params?: { width?: number; height?: number } } | null)?.params;
  const w = Math.round(Number(p?.width) || 0);
  const h = Math.round(Number(p?.height) || 0);
  if (w < 120 || h < 72) return;
  if (w === c.value.w && h === c.value.h) return;
  c.value.w = w;
  c.value.h = h;
  store.markGraphDirty();
}
</script>

<template>
  <div
    class="gcomment"
    :class="{ selected }"
    :style="{ background: hexToRgba(c.color, 0.1), borderColor: hexToRgba(c.color, 0.55) }"
  >
    <NodeResizer
      :node-id="id"
      :is-visible="selected"
      :min-width="120"
      :min-height="72"
      color="#4a9eff"
      @resize-start="store.canvas?.requestSnapshot()"
      @resize-end="onResizeEnd"
    />
    <div class="gcomment-bar" :style="{ background: c.color }"></div>
    <div v-if="c.text" class="gcomment-text">{{ c.text }}</div>
  </div>
</template>
