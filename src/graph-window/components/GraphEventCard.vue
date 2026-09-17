<script setup lang="ts">
/**
 * 事件卡片（执行链入口）：OnBegin（启动时触发一次）/ OnTick（每帧触发）/
 * OnClick（指针射线命中目标时触发）。仅有 next（执行链）输出引脚；
 * OnClick 额外有 in（实体集）入引脚指定可点击目标。
 */
import { computed } from "vue";
import { Handle, Position } from "@vue-flow/core";
import { nodeTypeDef, G_OP_TRIGGER_LABEL, type GNode } from "../../framework/graph";

const props = defineProps<{ id: string; data: { g: GNode }; selected?: boolean }>();

const g = computed(() => props.data.g);
const def = computed(() => nodeTypeDef(g.value.type));
const color = computed(() => def.value?.color ?? "#c586c0");
const hasTargetInput = computed(() => g.value.type === "event.onClick");
</script>

<template>
  <div class="gcard gevent" :class="{ selected }" :style="{ '--gcard-color': color }">
    <div class="gcard-head">
      <span class="gcard-dot"></span>
      <span class="gcard-title">{{ def?.label || "事件" }}</span>
      <span class="gcard-badge">{{ def && def.trigger ? G_OP_TRIGGER_LABEL[def.trigger] : "" }}</span>
    </div>
    <div v-if="def?.desc" class="gcard-summary" :title="def.desc">{{ def.desc }}</div>
    <div class="gcard-body">
      <div class="gcard-col">
        <div v-if="hasTargetInput" class="gprow">
          <Handle type="target" :position="Position.Left" id="in" class="gpin entities" :style="{ background: '#6a9955' }" />
          <span class="gpin-label">目标</span>
        </div>
      </div>
      <div class="gcard-col">
        <div class="gprow right">
          <span class="gpin-label">执行</span>
          <Handle type="source" :position="Position.Right" id="next" class="gpin exec" :style="{ background: '#f2f2f2' }" />
        </div>
      </div>
    </div>
  </div>
</template>