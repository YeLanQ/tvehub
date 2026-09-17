<script setup lang="ts">
/**
 * 变量卡片：var.get（纯数据读，仅 value 出引脚）/ var.set（exec 链写，
 * exec 入 + value 数据入 + next 出 + value 数据出）。
 * 卡片显示变量名与类型徽标；变量名从图变量表查找（varId 引用）。
 */
import { computed } from "vue";
import { Handle, Position } from "@vue-flow/core";
import { nodeTypeDef, type GNode } from "../../framework/graph";
import { getGraphWindowStore } from "../graphStore";

const props = defineProps<{ id: string; data: { g: GNode }; selected?: boolean }>();
const store = getGraphWindowStore();

const g = computed(() => props.data.g);
const def = computed(() => nodeTypeDef(g.value.type));
const color = computed(() => def.value?.color ?? "#88c0d0");
const isSet = computed(() => g.value.type === "var.set");
/** 引用变量的显示名 + 类型徽标 */
const varInfo = computed(() => {
  const vid = g.value.varId ?? "";
  const v = store.graphVariables.find((x) => x.id === vid);
  return v ? { name: v.name, type: v.dataType } : { name: "未绑定", type: "" };
});
const typeBadge = computed(() => {
  switch (varInfo.value.type) {
    case "number": return "数";
    case "boolean": return "布";
    case "string": return "串";
    default: return "?";
  }
});
</script>

<template>
  <div class="gcard gvar" :class="{ selected }" :style="{ '--gcard-color': color }">
    <div class="gcard-head">
      <span class="gcard-dot"></span>
      <span class="gcard-title">{{ def?.label || "变量" }}</span>
      <span class="gcard-badge">{{ typeBadge }}</span>
    </div>
    <div class="gcard-summary" :title="varInfo.name">{{ varInfo.name }}</div>
    <div class="gcard-body">
      <div class="gcard-col">
        <template v-if="isSet">
          <div class="gprow">
            <Handle type="target" :position="Position.Left" id="exec" class="gpin exec" :style="{ background: '#f2f2f2' }" />
            <span class="gpin-label">执行</span>
          </div>
          <div class="gprow">
            <Handle type="target" :position="Position.Left" id="value" class="gpin data" :style="{ background: '#88c0d0' }" />
            <span class="gpin-label">值</span>
          </div>
        </template>
      </div>
      <div class="gcard-col">
        <div class="gprow right">
          <span class="gpin-label">值</span>
          <Handle type="source" :position="Position.Right" id="value" class="gpin data" :style="{ background: '#88c0d0' }" />
        </div>
        <template v-if="isSet">
          <div class="gprow right">
            <span class="gpin-label">执行</span>
            <Handle type="source" :position="Position.Right" id="next" class="gpin exec" :style="{ background: '#f2f2f2' }" />
          </div>
        </template>
      </div>
    </div>
  </div>
</template>