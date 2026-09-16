<script setup lang="ts">
/**
 * 注释框（Vue Flow 自定义节点，经 #node-gcomment 插槽挂载）：
 * 半透明底 + 主题色边条的便签矩形；选中时出现 NodeResizer 缩放手柄，
 * 文本/颜色在右侧检查器编辑。缩放起手压入 undo 快照（拖拽由画布统一处理）。
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
</script>

<template>
  <div
    class="gcomment"
    :class="{ selected }"
    :style="{ background: hexToRgba(c.color, 0.1), borderColor: hexToRgba(c.color, 0.55) }"
  >
    <NodeResizer
      :visible="selected"
      :min-width="120"
      :min-height="72"
      color="#4a9eff"
      @resize-start="store.canvas?.requestSnapshot()"
    />
    <div class="gcomment-bar" :style="{ background: c.color }"></div>
    <div v-if="c.text" class="gcomment-text">{{ c.text }}</div>
  </div>
</template>
