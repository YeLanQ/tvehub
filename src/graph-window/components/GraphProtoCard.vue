<script setup lang="ts">
/**
 * 原型卡片（拖入的场景实体）：按场景实体索引显示实时属性参照 ——
 * 名称/类型徽标 + 变换摘要 + 可见性/标签；实体被删除时显示缺失警告。
 * 暴露的属性即编辑器/SDK 可操作项，供操作节点（op.set）按路径引用。
 */
import { computed } from "vue";
import { Handle, Position } from "@vue-flow/core";
import { getGraphWindowStore } from "../graphStore";
import type { GNode } from "../../framework/graph";

const props = defineProps<{ id: string; data: { g: GNode }; selected?: boolean }>();

const store = getGraphWindowStore();
const g = computed(() => props.data.g);
const entity = computed(() => store.sceneEntities.find((e) => e.id === g.value.entityId) ?? null);

const posText = computed(() =>
  entity.value
    ? `${entity.value.position.x.toFixed(1)}, ${entity.value.position.y.toFixed(1)}, ${entity.value.position.z.toFixed(1)}`
    : "",
);
const rotText = computed(() =>
  entity.value
    ? `${entity.value.rotation.x.toFixed(0)}°, ${entity.value.rotation.y.toFixed(0)}°, ${entity.value.rotation.z.toFixed(0)}°`
    : "",
);
</script>

<template>
  <div class="gcard gproto" :class="{ selected }" :style="{ '--gcard-color': '#569cd6' }">
    <div class="gcard-head">
      <span class="gcard-dot"></span>
      <span class="gcard-title" :title="g.entityId">{{ entity?.name || "原型" }}</span>
      <span class="gcard-badge">{{ entity?.type || "?" }}</span>
    </div>

    <template v-if="entity">
      <div class="gcard-rows">
        <div class="grow"><span class="gk">位置</span><span class="gv mono">{{ posText }}</span></div>
        <div class="grow"><span class="gk">旋转</span><span class="gv mono">{{ rotText }}</span></div>
        <div class="grow">
          <span class="gk">状态</span>
          <span class="gv">{{ entity.visible ? "可见" : "隐藏" }}{{ entity.tag ? ` · ${entity.tag}` : "" }}</span>
        </div>
      </div>
    </template>
    <div v-else class="gcard-missing">实体不在当前场景（可能已被删除）</div>

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
