<script setup lang="ts">
/**
 * 数学/工具节点卡片：纯数据节点（算术/三角/向量/字符串/插值）。
 * 端口从注册表动态渲染（inputs 左 / outputs 右），按 dataType 配色。
 */
import { computed } from "vue";
import { Handle, Position } from "@vue-flow/core";
import { nodeTypeDef, type GNode } from "../../framework/graph";

const props = defineProps<{ id: string; data: { g: GNode }; selected?: boolean }>();

const g = computed(() => props.data.g);
const def = computed(() => nodeTypeDef(g.value.type));
const color = computed(() => def.value?.color ?? "#4ec9b0");

const pinColor = (dataType: string): string => {
  switch (dataType) {
    case "number": return "#88c0d0";
    case "boolean": return "#c586c0";
    case "string": return "#ce9178";
    case "vec3": return "#569cd6";
    case "entities": case "entity": return "#6a9955";
    default: return "#88c0d0";
  }
};
</script>

<template>
  <div class="gcard gmath" :class="{ selected }" :style="{ '--gcard-color': color }">
    <div class="gcard-head">
      <span class="gcard-dot"></span>
      <span class="gcard-title">{{ def?.label || "数学" }}</span>
    </div>
    <div v-if="def?.desc" class="gcard-summary" :title="def.desc">{{ def.desc }}</div>
    <div class="gcard-body">
      <div class="gcard-col">
        <div v-for="p in def?.inputs" :key="p.id" class="gprow">
          <Handle type="target" :position="Position.Left" :id="p.id" class="gpin" :style="{ background: pinColor(p.dataType) }" />
          <span class="gpin-label">{{ p.label }}</span>
        </div>
      </div>
      <div class="gcard-col">
        <div v-for="p in def?.outputs" :key="p.id" class="gprow right">
          <span class="gpin-label">{{ p.label }}</span>
          <Handle type="source" :position="Position.Right" :id="p.id" class="gpin" :style="{ background: pinColor(p.dataType) }" />
        </div>
      </div>
    </div>
  </div>
</template>