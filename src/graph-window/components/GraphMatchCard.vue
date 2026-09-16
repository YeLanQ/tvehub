<script setup lang="ts">
/**
 * 匹配卡片（标签 / 类型筛选）：按当前场景实体索引实时求值命中的实体集，
 * 连到操作节点即批量施加（运行时按 userData.nodeTag/nodeKind 解析）。
 */
import { computed } from "vue";
import { Handle, Position } from "@vue-flow/core";
import { byTag, byType } from "../lib/scene-index";
import { getGraphWindowStore } from "../graphStore";
import type { GNode } from "../../framework/graph";

const props = defineProps<{ id: string; data: { g: GNode }; selected?: boolean }>();

const store = getGraphWindowStore();
const g = computed(() => props.data.g);

const matched = computed(() => {
  const node = g.value;
  if (node.kind !== "match") return [];
  return node.matchMode === "type"
    ? byType(store.sceneEntities, node.matchPattern ?? "")
    : byTag(store.sceneEntities, node.matchPattern ?? "");
});
</script>

<template>
  <div class="gcard gmatch" :class="{ selected }" :style="{ '--gcard-color': '#c586c0' }">
    <div class="gcard-head">
      <span class="gcard-dot"></span>
      <span class="gcard-title">{{ g.matchMode === "type" ? "按类型" : "按标签" }}</span>
      <span class="gcard-badge">{{ matched.length }} 个实体</span>
    </div>
    <div class="gcard-summary" :title="matched.map((m) => m.name).join(', ')">
      {{ g.matchPattern || "未设置模式串" }}{{ matched.length ? ` — ${matched.slice(0, 3).map((m) => m.name).join(", ")}${matched.length > 3 ? " …" : ""}` : "" }}
    </div>
    <div class="gcard-body">
      <div class="gcard-col"></div>
      <div class="gcard-col">
        <div class="gprow right">
          <span class="gpin-label">实体集</span>
          <Handle type="source" :position="Position.Right" id="out" class="gpin entities" :style="{ background: '#6a9955' }" />
        </div>
      </div>
    </div>
  </div>
</template>
