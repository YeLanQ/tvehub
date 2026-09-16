<script setup lang="ts">
/**
 * 操作卡片（原子行为）：触发时机徽标（启动时/每帧/点击时）+ 参数摘要。
 * 实体集入引脚决定作用对象（原型/匹配），执行链入出引脚串联级联应用；
 * 行为在预览运行时由 graph-behaviors 解释执行，不在编辑态改动场景。
 */
import { computed } from "vue";
import { Handle, Position } from "@vue-flow/core";
import {
  G_OP_TRIGGER_LABEL,
  graphOpDef,
  graphOpSummary,
  type GNode,
} from "../../framework/graph";

const props = defineProps<{ id: string; data: { g: GNode }; selected?: boolean }>();

const g = computed(() => props.data.g);
const def = computed(() => graphOpDef(g.value.opType ?? ""));
const color = computed(() => def.value?.color ?? "#666");
const summary = computed(() => graphOpSummary(g.value.opType ?? "", g.value.params));
</script>

<template>
  <div class="gcard gop" :class="{ selected }" :style="{ '--gcard-color': color }">
    <div class="gcard-head">
      <span class="gcard-dot"></span>
      <span class="gcard-title">{{ def?.label || "操作" }}</span>
      <span class="gcard-badge">{{ def ? G_OP_TRIGGER_LABEL[def.trigger] : "?" }}</span>
    </div>
    <div v-if="summary" class="gcard-summary" :title="summary">{{ summary }}</div>
    <div class="gcard-body">
      <div class="gcard-col">
        <div class="gprow">
          <Handle type="target" :position="Position.Left" id="in" class="gpin entities" :style="{ background: '#6a9955' }" />
          <span class="gpin-label">目标</span>
        </div>
        <div class="gprow">
          <Handle type="target" :position="Position.Left" id="exec" class="gpin exec" :style="{ background: '#f2f2f2' }" />
          <span class="gpin-label">执行</span>
        </div>
      </div>
      <div class="gcard-col">
        <div class="gprow right">
          <span class="gpin-label">目标</span>
          <Handle type="source" :position="Position.Right" id="out" class="gpin entities" :style="{ background: '#6a9955' }" />
        </div>
        <div class="gprow right">
          <span class="gpin-label">执行</span>
          <Handle type="source" :position="Position.Right" id="next" class="gpin exec" :style="{ background: '#f2f2f2' }" />
        </div>
      </div>
    </div>
  </div>
</template>
