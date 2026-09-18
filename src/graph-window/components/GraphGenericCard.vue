<script setup lang="ts">
/**
 * 通用节点卡片（注册表驱动，注入模块零 UI 成本出卡）：
 * - 已知类型：标题/端口（按注册表 inputs/outputs + dataType 配色）/参数摘要；
 * - unresolved（模块未装载）：灰卡 + 缺失徽标 + 类型键——保留节点内容
 *   （normalize 不静默剔除），模块装载后重新收敛自动恢复连线语义。
 */
import { computed } from "vue";
import { Handle, Position } from "@vue-flow/core";
import { graphNodeLabel, nodeTypeDef, type GNode } from "../../framework/graph";

const props = defineProps<{ id: string; data: { g: GNode }; selected?: boolean }>();

const g = computed(() => props.data.g);
const def = computed(() => nodeTypeDef(g.value.type));
const unresolved = computed(() => g.value.unresolved === true);
const color = computed(() => (unresolved.value ? "#666" : def.value?.color ?? "#4ec9b0"));
const title = computed(() => (unresolved.value ? "模块未装载" : graphNodeLabel(g.value, { typeLabel: (t) => def.value?.label ?? t })));

const pinColor = (dataType: string): string => {
  switch (dataType) {
    case "exec": return "#f2f2f2";
    case "number": return "#88c0d0";
    case "boolean": return "#c586c0";
    case "string": return "#ce9178";
    case "vec3": return "#569cd6";
    case "entities": case "entity": return "#6a9955";
    default: return "#88c0d0";
  }
};

/** 参数摘要（非缺省字段一行展示） */
const summary = computed(() => {
  const fields = def.value?.fields ?? [];
  const parts: string[] = [];
  for (const f of fields) {
    const v = g.value.params?.[f.key];
    if (v === undefined || v === "" || v === f.fallback) continue;
    parts.push(f.kind === "boolean" ? `${f.label}` : `${f.label} ${String(v)}`);
  }
  return parts.join(" · ");
});
</script>

<template>
  <div class="gcard ggeneric" :class="{ selected, unresolved }" :style="{ '--gcard-color': color }">
    <div class="gcard-head">
      <span class="gcard-dot"></span>
      <span class="gcard-title" :title="g.type">{{ title }}</span>
      <span v-if="unresolved" class="gcard-badge">缺失</span>
    </div>
    <div v-if="unresolved" class="gcard-summary" :title="g.type">节点类型 {{ g.type }} 的模块未装载</div>
    <div v-else-if="def?.desc" class="gcard-summary" :title="def.desc">{{ def.desc }}</div>
    <div v-else-if="summary" class="gcard-summary" :title="summary">{{ summary }}</div>
    <div v-if="!unresolved" class="gcard-body">
      <div class="gcard-col">
        <div v-for="p in def?.inputs" :key="p.id" class="gprow">
          <Handle type="target" :position="Position.Left" :id="p.id" class="gpin" :style="{ background: pinColor(p.dataType) }" />
          <span v-if="p.label" class="gpin-label">{{ p.label }}</span>
        </div>
      </div>
      <div class="gcard-col">
        <div v-for="p in def?.outputs" :key="p.id" class="gprow right">
          <span v-if="p.label" class="gpin-label">{{ p.label }}</span>
          <Handle type="source" :position="Position.Right" :id="p.id" class="gpin" :style="{ background: pinColor(p.dataType) }" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ggeneric.unresolved {
  opacity: 0.55;
  filter: grayscale(0.85);
  border-style: dashed !important;
}
</style>
