<script setup lang="ts">
/**
 * UI 画布（UI Canvas）卡片 —— Canvas-Widget 的 Canvas 容器：
 * - 渲染模式：屏幕叠加（相机叠加；画布空间每帧贴合活动渲染相机）；
 * - Sort Order：画布整体排序（多画布叠加时大者在上，优先于画布内 Widget 排序）。
 */
import { computed } from "vue";
import { UICanvasNode } from "../../../framework/prototype/derived/Primitives";
import NumberField from "../NumberField.vue";

const props = defineProps<{ node: UICanvasNode; rev?: number }>();

const emit = defineEmits<{
  update: [label: string, value: unknown];
}>();

/** 以 rev 为失效信号（节点是普通类实例，非响应式） */
const sortOrder = computed(() => {
  void props.rev;
  return props.node.sortOrder;
});

function onSortOrderCommit(v: number): void {
  if (v !== props.node.sortOrder) emit("update", "sortOrder", v);
}
</script>

<template>
  <div class="ui-section" :data-rev="rev">
    <div class="field">
      <label title="Render Mode">渲染模式</label>
      <select :value="node.renderMode" disabled title="当前仅支持屏幕叠加（相机叠加渲染）">
        <option value="overlay">屏幕叠加（Overlay）</option>
      </select>
    </div>
    <div class="field">
      <label title="Sort Order（多画布叠加时大者在上）">Sort Order</label>
      <NumberField
        :model-value="sortOrder"
        :step="1"
        :min="-500"
        :max="500"
        title="画布整体排序（多画布叠加时大者在上）"
        @commit="onSortOrderCommit"
      />
    </div>
    <div class="hint" title="UI 空间以屏幕中心为原点，+x 右 +y 上，纵向可见 10 个 UI 单位">
      画布子节点即 UI 坐标（原点=屏幕中心，纵向可见 10 单位）
    </div>
  </div>
</template>
