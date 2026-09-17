<script setup lang="ts">
/**
 * 操作卡片（原子行为）：触发时机徽标（启动时/每帧/点击时）+ 参数摘要。
 * 端口与字段全部由节点类型注册表驱动（nodeInputs/nodeOutputs）——
 * 通用操作 = 目标/执行/目标集/执行 四引脚；扩展操作（如 op.chase 的
 * 「追击目标」实体引脚）按注册表自动追加。
 * 实体集入引脚决定作用对象（原型/匹配），执行链入出引脚串联级联应用；
 * 行为在预览运行时由 graph-behaviors 解释执行，不在编辑态改动场景。
 */
import { computed } from "vue";
import { Handle, Position } from "@vue-flow/core";
import {
  G_OP_TRIGGER_LABEL,
  graphOpDef,
  graphOpSummary,
  nodeInputs,
  nodeOutputs,
  nodeTypeDef,
  type GNode,
} from "../../framework/graph";

const props = defineProps<{ id: string; data: { g: GNode }; selected?: boolean }>();

const g = computed(() => props.data.g);
const type = computed(() => g.value.opType ?? g.value.type);
/** 注册表定义（覆盖扩展操作，如 op.chase）；旧式目录用于触发时机与参数摘要 */
const tdef = computed(() => nodeTypeDef(type.value));
const odef = computed(() => graphOpDef(type.value));
const color = computed(() => tdef.value?.color ?? odef.value?.color ?? "#666");
const label = computed(() => tdef.value?.label ?? odef.value?.label ?? "操作");
const trigger = computed(() => tdef.value?.trigger ?? odef.value?.trigger);
const triggerLabel = computed(() =>
  trigger.value ? G_OP_TRIGGER_LABEL[trigger.value as keyof typeof G_OP_TRIGGER_LABEL] : "?",
);
const summary = computed(() => graphOpSummary(type.value, g.value.params));
const ins = computed(() => nodeInputs(type.value));
const outs = computed(() => nodeOutputs(type.value));

function pinClass(dataType: string): string {
  if (dataType === "exec") return "exec";
  if (dataType === "entity" || dataType === "entities") return "entities";
  return "data";
}
function pinBg(dataType: string): string {
  if (dataType === "exec") return "#f2f2f2";
  if (dataType === "entity" || dataType === "entities") return "#6a9955";
  return "#88c0d0";
}
</script>

<template>
  <div class="gcard gop" :class="{ selected }" :style="{ '--gcard-color': color }">
    <div class="gcard-head">
      <span class="gcard-dot"></span>
      <span class="gcard-title">{{ label }}</span>
      <span class="gcard-badge">{{ triggerLabel }}</span>
    </div>
    <div v-if="summary" class="gcard-summary" :title="summary">{{ summary }}</div>
    <div class="gcard-body">
      <div class="gcard-col">
        <div v-for="p in ins" :key="p.id" class="gprow">
          <Handle
            type="target"
            :position="Position.Left"
            :id="p.id"
            class="gpin"
            :class="pinClass(p.dataType)"
            :style="{ background: pinBg(p.dataType) }"
          />
          <span v-if="p.label" class="gpin-label">{{ p.label }}</span>
        </div>
      </div>
      <div class="gcard-col">
        <div v-for="p in outs" :key="p.id" class="gprow right">
          <span v-if="p.label" class="gpin-label">{{ p.label }}</span>
          <Handle
            type="source"
            :position="Position.Right"
            :id="p.id"
            class="gpin"
            :class="pinClass(p.dataType)"
            :style="{ background: pinBg(p.dataType) }"
          />
        </div>
      </div>
    </div>
  </div>
</template>
