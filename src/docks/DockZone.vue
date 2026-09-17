<script setup lang="ts">
/**
 * 通用停靠区（编辑器/图窗口共用）：
 * 页签拖拽（移动/停靠/浮动）、点击激活、空区细条落点；
 * 面板内容由 panels 映射（面板名 → 组件）按激活页签渲染——
 * 同一面板只存在一个实例，避免状态不同步。
 */
import { computed, onMounted, onUnmounted, ref, type Component } from "vue";
import type { DockSystem, DockZoneId } from "./types";
import "../styles/components/dock-zone.scss";

const props = defineProps<{
  sys: DockSystem<string>;
  zone: DockZoneId;
  panels: Record<string, Component>;
}>();

const el = ref<HTMLElement | null>(null);

const panels = computed(() => props.sys.layout.zones[props.zone]);
/** 当前激活面板（区域为空时 null） */
const activePanel = computed(() => {
  const a = props.sys.layout.active[props.zone];
  return panels.value.includes(a) ? a : (panels.value[0] ?? null);
});
/** 当前激活面板的组件（区域为空或映射缺失时 null） */
const activeComp = computed(() =>
  activePanel.value ? (props.panels[activePanel.value] ?? null) : null,
);

const zoneStyle = computed(() => {
  // 空区：折叠成细条（仍是拖放落点，可拖回面板停靠）；非空按 sizes
  const empty = panels.value.length === 0;
  if (props.zone === "bottom") return { height: `${empty ? 14 : props.sys.layout.sizes.bottom}px` };
  return { width: `${empty ? 14 : props.sys.layout.sizes[props.zone]}px` };
});

/** 拖拽落点高亮：仅实际拖拽（moved）时显示，普通点击不闪蓝 */
const isDropTarget = computed(
  () =>
    props.sys.dnd.active &&
    props.sys.dnd.moved &&
    props.sys.dnd.target?.kind === "zone" &&
    props.sys.dnd.target.zone === props.zone,
);

/** 标签插入位置（落点索引对应的标签显示左侧插入线） */
const insertIndex = computed(() => (isDropTarget.value ? props.sys.dnd.target!.index : -1));

function onTabDown(e: MouseEvent, panelId: string) {
  if (e.button !== 0) return;
  e.preventDefault();
  props.sys.beginTabDrag(panelId, props.zone, e.clientX, e.clientY);
}

onMounted(() => {
  props.sys.registerZoneEl(props.zone, el.value);
});
onUnmounted(() => {
  props.sys.registerZoneEl(props.zone, null);
});
</script>

<template>
  <div
    ref="el"
    class="dock-zone"
    :class="[zone, { 'drop-target': isDropTarget }]"
    :style="zoneStyle"
    @contextmenu.prevent
  >
    <template v-if="panels.length">
      <div class="dock-tabs">
        <div
          v-for="(p, i) in panels"
          :key="p"
          class="dock-tab"
          :class="{ active: p === activePanel, 'drop-pos': i === insertIndex }"
          :data-dock-tab="p"
          title="拖拽移动面板；点击激活"
          @mousedown="onTabDown($event, p)"
          @click="sys.activate(zone, p)"
        >
          {{ sys.labels[p] }}
        </div>
      </div>
      <div class="dock-body">
        <component :is="activeComp" v-if="activeComp" />
      </div>
    </template>
    <!-- 空停靠区：细条拖放落点（拖回面板停靠） -->
    <div v-else class="dock-empty">
      <span class="dock-empty-hint">⤢</span>
      <span class="dock-empty-title">拖面板到此停靠</span>
    </div>
  </div>
</template>
