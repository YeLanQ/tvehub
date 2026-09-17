<script setup lang="ts">
/**
 * 逻辑容器卡（状态机容器 / 行为树容器）：大框渲染，子节点以 containerId
 * 归属（画布拖入范围即归属，可嵌套）。
 * - 状态机容器：params.states（逗号分隔）声明状态、params.initial 初始状态；
 *   头部渲染状态 chips；运行时进入激活 initial，event 入端口按事件名切换状态，
 *   激活状态执行归属该状态的子节点链；
 * - 行为树容器：进入时按子节点纵向排序依次执行（顺序节点语义），完成后触发退出。
 * 端口：exec「进入」/「退出」+ 事件入（仅状态机）+ 实体集作用域入/出。
 * 尺寸由 g.w/g.h 决定（检查器可调），拖动容器整棵子树随动（GraphCanvas 处理）。
 */
import { computed } from "vue";
import { Handle, Position } from "@vue-flow/core";
import type { GNode } from "../../framework/graph";

const props = defineProps<{ id: string; data: { g: GNode }; selected?: boolean }>();
const g = computed(() => props.data.g);
const isFsm = computed(() => g.value.type === "fsm.container");
const color = computed(() => (isFsm.value ? "#569cd6" : "#4ec9b0"));

const sizeStyle = computed(() => ({
  width: `${g.value.w ?? 560}px`,
  height: `${g.value.h ?? 340}px`,
  "--gcard-color": color.value,
}));

/** 状态列表（params.states 逗号分隔） */
const states = computed<string[]>(() =>
  (g.value.params?.states ?? "")
    .toString()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const initial = computed(() => (g.value.params?.initial ?? "").toString().trim() || states.value[0] || "");
const mode = computed(() => (g.value.params?.mode ?? "").toString() || "sequence");
const treeSummary = computed(() => (g.value.params?.treeSummary ?? "").toString());
</script>

<template>
  <div class="gcontainer" :class="{ selected, fsm: isFsm, bt: !isFsm }" :style="sizeStyle">
    <div class="gcontainer-head">
      <span class="gcontainer-dot" :style="{ background: color }"></span>
      <span class="gcontainer-title">{{ isFsm ? "状态机容器" : "行为树容器" }}</span>
      <span v-if="isFsm" class="gcontainer-badge">initial: {{ initial || "—" }}</span>
      <span v-else class="gcontainer-badge">{{ mode }}</span>
    </div>

    <!-- 行为树：接入 .bt 资产后显示节点构成摘要 -->
    <div v-if="!isFsm && treeSummary" class="gcontainer-tree">
      <span class="gtree-chip">{{ treeSummary }}</span>
    </div>

    <!-- 状态机：状态 chips（归属子节点可在检查器设置 stateName 接入状态） -->
    <div v-if="isFsm && states.length" class="gcontainer-states">
      <span
        v-for="s in states"
        :key="s"
        class="gstate-chip"
        :class="{ initial: s === initial }"
        :title="s === initial ? `初始状态（子节点 stateName = ${s} 归属此状态）` : `状态（子节点 stateName = ${s} 归属此状态）`"
      >
        {{ s }}
      </span>
    </div>
    <div class="gcontainer-hint">拖入节点到框内即归属（可嵌套）</div>

    <!-- 端口：左侧 进入/事件/作用域，右侧 退出/输出 -->
    <Handle type="target" :position="Position.Left" id="exec" class="gpin exec" :style="{ top: '38px' }" />
    <div class="gpin-label left" :style="{ top: '30px' }">进入</div>
    <Handle
      v-if="isFsm"
      type="target"
      :position="Position.Left"
      id="event"
      class="gpin exec"
      :style="{ top: '66px' }"
    />
    <div v-if="isFsm" class="gpin-label left" :style="{ top: '58px' }">事件</div>
    <Handle type="target" :position="Position.Left" id="in" class="gpin entities" :style="{ top: '94px' }" />
    <div class="gpin-label left" :style="{ top: '86px' }">作用域</div>
    <Handle type="source" :position="Position.Right" id="next" class="gpin exec" :style="{ top: '38px' }" />
    <div class="gpin-label right" :style="{ top: '30px' }">退出</div>
    <Handle type="source" :position="Position.Right" id="out" class="gpin entities" :style="{ top: '94px' }" />
    <div class="gpin-label right" :style="{ top: '86px' }">输出</div>
  </div>
</template>

<style scoped>
.gcontainer {
  position: relative;
  border: 1.5px dashed var(--gcard-color, #569cd6);
  border-radius: 10px;
  background: color-mix(in srgb, var(--gcard-color, #569cd6) 7%, transparent);
  box-sizing: border-box;
}
.gcontainer.selected {
  border-color: #fff;
  box-shadow: 0 0 0 1.5px #fff;
}
.gcontainer-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px 7px;
  border-bottom: 1px solid color-mix(in srgb, var(--gcard-color, #569cd6) 40%, transparent);
}
.gcontainer-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex: none;
}
.gcontainer-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.gcontainer-badge {
  font-size: 11px;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 6px;
}
.gcontainer-states {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 12px 0;
}
.gstate-chip {
  font-size: 11px;
  padding: 2px 9px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--gcard-color, #569cd6) 55%, transparent);
  color: var(--text-dim);
}
.gstate-chip.initial {
  color: #fff;
  background: color-mix(in srgb, var(--gcard-color, #569cd6) 55%, transparent);
}
.gcontainer-tree {
  padding: 6px 12px 0;
}
.gtree-chip {
  font-size: 11px;
  padding: 2px 9px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--gcard-color, #4ec9b0) 55%, transparent);
  color: var(--text-dim);
}
.gcontainer-hint {
  padding: 8px 12px 0;
  font-size: 11px;
  color: var(--text-dim);
  opacity: 0.75;
}
.gpin-label {
  position: absolute;
  font-size: 10.5px;
  color: var(--text-dim);
  pointer-events: none;
}
.gpin-label.left {
  left: 14px;
}
.gpin-label.right {
  right: 14px;
}
</style>
