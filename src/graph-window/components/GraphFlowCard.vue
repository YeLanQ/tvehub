<script setup lang="ts">
/**
 * 控制流卡片：Branch（条件分支）/ Compare（比较 → 布尔）/ For（计数循环）/
 * ForEach（实体遍历）/ While（条件循环）/ Gate（中断开关，通断控制）。
 * - Branch：exec 入 + condition 数据入 → true/false exec 出
 * - Compare：a/b 数据入 → result 布尔出（纯数据节点）
 * - For：exec 入 + start/end/step 数据入 → loop exec 出 + index 数据出 + completed exec 出
 * - ForEach：exec 入 + array 实体集入 → loop exec 出 + item 实体出 + completed exec 出
 * - While：exec 入 + condition 数据入 → loop exec 出 + completed exec 出
 * - Gate：exec 入 + on/off exec 控制入 → next exec 出（「关」中断下游，「开」恢复）
 */
import { computed } from "vue";
import { Handle, Position } from "@vue-flow/core";
import { nodeTypeDef, type GNode } from "../../framework/graph";

const props = defineProps<{ id: string; data: { g: GNode }; selected?: boolean }>();

const g = computed(() => props.data.g);
const def = computed(() => nodeTypeDef(g.value.type));
const color = computed(() => def.value?.color ?? "#c586c0");
const isBranch = computed(() => g.value.type === "flow.branch");
const isCompare = computed(() => g.value.type === "flow.compare");
const isFor = computed(() => g.value.type === "flow.for");
const isForEach = computed(() => g.value.type === "flow.forEach");
const isWhile = computed(() => g.value.type === "flow.while");
const isGate = computed(() => g.value.type === "flow.gate");
/** Compare 运算符徽标 */
const opBadge = computed(() => String(g.value.params?.operator ?? ">"));
/** Gate 初始通断徽标 */
const gateBadge = computed(() => (g.value.params?.initialOpen === true ? "初始断开" : "初始导通"));
</script>

<template>
  <div class="gcard gflow" :class="{ selected }" :style="{ '--gcard-color': color }">
    <div class="gcard-head">
      <span class="gcard-dot"></span>
      <span class="gcard-title">{{ def?.label || "控制流" }}</span>
      <span v-if="isCompare" class="gcard-badge">{{ opBadge }}</span>
      <span v-else-if="isGate" class="gcard-badge">{{ gateBadge }}</span>
    </div>
    <div v-if="def?.desc" class="gcard-summary" :title="def.desc">{{ def.desc }}</div>
    <div class="gcard-body">
      <div class="gcard-col">
        <!-- Branch: exec + condition -->
        <template v-if="isBranch">
          <div class="gprow">
            <Handle type="target" :position="Position.Left" id="exec" class="gpin exec" :style="{ background: '#f2f2f2' }" />
            <span class="gpin-label">执行</span>
          </div>
          <div class="gprow">
            <Handle type="target" :position="Position.Left" id="condition" class="gpin data" :style="{ background: '#88c0d0' }" />
            <span class="gpin-label">条件</span>
          </div>
        </template>
        <!-- Compare: a + b (纯数据) -->
        <template v-else-if="isCompare">
          <div class="gprow">
            <Handle type="target" :position="Position.Left" id="a" class="gpin data" :style="{ background: '#88c0d0' }" />
            <span class="gpin-label">A</span>
          </div>
          <div class="gprow">
            <Handle type="target" :position="Position.Left" id="b" class="gpin data" :style="{ background: '#88c0d0' }" />
            <span class="gpin-label">B</span>
          </div>
        </template>
        <!-- For: exec + start + end + step -->
        <template v-else-if="isFor">
          <div class="gprow">
            <Handle type="target" :position="Position.Left" id="exec" class="gpin exec" :style="{ background: '#f2f2f2' }" />
            <span class="gpin-label">执行</span>
          </div>
          <div class="gprow">
            <Handle type="target" :position="Position.Left" id="start" class="gpin data" :style="{ background: '#88c0d0' }" />
            <span class="gpin-label">起始</span>
          </div>
          <div class="gprow">
            <Handle type="target" :position="Position.Left" id="end" class="gpin data" :style="{ background: '#88c0d0' }" />
            <span class="gpin-label">结束</span>
          </div>
          <div class="gprow">
            <Handle type="target" :position="Position.Left" id="step" class="gpin data" :style="{ background: '#88c0d0' }" />
            <span class="gpin-label">步长</span>
          </div>
        </template>
        <!-- ForEach: exec + array -->
        <template v-else-if="isForEach">
          <div class="gprow">
            <Handle type="target" :position="Position.Left" id="exec" class="gpin exec" :style="{ background: '#f2f2f2' }" />
            <span class="gpin-label">执行</span>
          </div>
          <div class="gprow">
            <Handle type="target" :position="Position.Left" id="array" class="gpin entities" :style="{ background: '#6a9955' }" />
            <span class="gpin-label">集合</span>
          </div>
        </template>
        <!-- While: exec + condition -->
        <template v-else-if="isWhile">
          <div class="gprow">
            <Handle type="target" :position="Position.Left" id="exec" class="gpin exec" :style="{ background: '#f2f2f2' }" />
            <span class="gpin-label">执行</span>
          </div>
          <div class="gprow">
            <Handle type="target" :position="Position.Left" id="condition" class="gpin data" :style="{ background: '#88c0d0' }" />
            <span class="gpin-label">条件</span>
          </div>
        </template>
        <!-- Gate: exec + on + off -->
        <template v-else-if="isGate">
          <div class="gprow">
            <Handle type="target" :position="Position.Left" id="exec" class="gpin exec" :style="{ background: '#f2f2f2' }" />
            <span class="gpin-label">执行</span>
          </div>
          <div class="gprow">
            <Handle type="target" :position="Position.Left" id="on" class="gpin exec" :style="{ background: '#f2f2f2' }" />
            <span class="gpin-label">开</span>
          </div>
          <div class="gprow">
            <Handle type="target" :position="Position.Left" id="off" class="gpin exec" :style="{ background: '#f2f2f2' }" />
            <span class="gpin-label">关</span>
          </div>
        </template>
      </div>
      <div class="gcard-col">
        <!-- Branch: true + false -->
        <template v-if="isBranch">
          <div class="gprow right">
            <span class="gpin-label">真</span>
            <Handle type="source" :position="Position.Right" id="true" class="gpin exec" :style="{ background: '#f2f2f2' }" />
          </div>
          <div class="gprow right">
            <span class="gpin-label">假</span>
            <Handle type="source" :position="Position.Right" id="false" class="gpin exec" :style="{ background: '#f2f2f2' }" />
          </div>
        </template>
        <!-- Compare: result -->
        <template v-else-if="isCompare">
          <div class="gprow right">
            <span class="gpin-label">结果</span>
            <Handle type="source" :position="Position.Right" id="result" class="gpin data" :style="{ background: '#88c0d0' }" />
          </div>
        </template>
        <!-- For: loop + index + completed -->
        <template v-else-if="isFor">
          <div class="gprow right">
            <span class="gpin-label">循环</span>
            <Handle type="source" :position="Position.Right" id="loop" class="gpin exec" :style="{ background: '#f2f2f2' }" />
          </div>
          <div class="gprow right">
            <span class="gpin-label">索引</span>
            <Handle type="source" :position="Position.Right" id="index" class="gpin data" :style="{ background: '#88c0d0' }" />
          </div>
          <div class="gprow right">
            <span class="gpin-label">完成</span>
            <Handle type="source" :position="Position.Right" id="completed" class="gpin exec" :style="{ background: '#f2f2f2' }" />
          </div>
        </template>
        <!-- ForEach: loop + item + completed -->
        <template v-else-if="isForEach">
          <div class="gprow right">
            <span class="gpin-label">循环</span>
            <Handle type="source" :position="Position.Right" id="loop" class="gpin exec" :style="{ background: '#f2f2f2' }" />
          </div>
          <div class="gprow right">
            <span class="gpin-label">当前</span>
            <Handle type="source" :position="Position.Right" id="item" class="gpin entities" :style="{ background: '#6a9955' }" />
          </div>
          <div class="gprow right">
            <span class="gpin-label">完成</span>
            <Handle type="source" :position="Position.Right" id="completed" class="gpin exec" :style="{ background: '#f2f2f2' }" />
          </div>
        </template>
        <!-- While: loop + completed -->
        <template v-else-if="isWhile">
          <div class="gprow right">
            <span class="gpin-label">循环</span>
            <Handle type="source" :position="Position.Right" id="loop" class="gpin exec" :style="{ background: '#f2f2f2' }" />
          </div>
          <div class="gprow right">
            <span class="gpin-label">完成</span>
            <Handle type="source" :position="Position.Right" id="completed" class="gpin exec" :style="{ background: '#f2f2f2' }" />
          </div>
        </template>
        <!-- Gate: next -->
        <template v-else-if="isGate">
          <div class="gprow right">
            <span class="gpin-label">下游</span>
            <Handle type="source" :position="Position.Right" id="next" class="gpin exec" :style="{ background: '#f2f2f2' }" />
          </div>
        </template>
      </div>
    </div>
  </div>
</template>