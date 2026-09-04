<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  docks,
  dockDnd,
  activate,
  beginTabDrag,
  registerZoneEl,
  DOCK_PANEL_LABEL,
  type DockPanelId,
  type DockZoneId,
} from "../docks";
import HierarchyPanel from "./HierarchyPanel.vue";
import InspectorPanel from "./InspectorPanel.vue";
import ConsolePanel from "./ConsolePanel.vue";
import AssetsPanel from "./AssetsPanel.vue";

const props = defineProps<{ zone: DockZoneId }>();

const el = ref<HTMLElement | null>(null);

const panels = computed(() => docks.zones[props.zone]);
/** 当前激活面板（区域为空时 null） */
const activePanel = computed(() => {
  const a = docks.active[props.zone];
  return panels.value.includes(a) ? a : (panels.value[0] ?? null);
});

const zoneStyle = computed(() => {
  // 空区：折叠成细条（仍是拖放落点，可拖回面板停靠）；非空按 sizes
  const empty = panels.value.length === 0;
  if (props.zone === "bottom") return { height: `${empty ? 14 : docks.sizes.bottom}px` };
  return { width: `${empty ? 14 : docks.sizes[props.zone]}px` };
});

/** 拖拽落点高亮：仅实际拖拽（moved）时显示，普通点击不闪蓝 */
const isDropTarget = computed(
  () =>
    dockDnd.active &&
    dockDnd.moved &&
    dockDnd.target?.kind === "zone" &&
    dockDnd.target.zone === props.zone,
);

/** 标签插入位置（落点索引对应的标签显示左侧插入线） */
const insertIndex = computed(() => (isDropTarget.value ? dockDnd.target!.index : -1));

function onTabDown(e: MouseEvent, panelId: DockPanelId) {
  if (e.button !== 0) return;
  e.preventDefault();
  beginTabDrag(panelId, props.zone, e.clientX, e.clientY);
}

onMounted(() => {
  registerZoneEl(props.zone, el.value);
});
onUnmounted(() => {
  registerZoneEl(props.zone, null);
});
</script>

<template>
  <div
    ref="el"
    class="dock-zone"
    :class="[zone, { 'drop-target': isDropTarget }]"
    :style="zoneStyle"
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
          @click="activate(zone, p)"
        >
          {{ DOCK_PANEL_LABEL[p] }}
        </div>
      </div>
      <div class="dock-body">
      <!-- v-if：同一面板只存在一个实例，避免状态不同步 -->
      <HierarchyPanel v-if="activePanel === 'hierarchy'" />
      <InspectorPanel v-if="activePanel === 'inspector'" />
      <ConsolePanel v-if="activePanel === 'console'" />
      <AssetsPanel v-if="activePanel === 'assets'" />
    </div>
    </template>
    <!-- 空停靠区：细条拖放落点（拖回面板停靠） -->
    <div v-else class="dock-empty">
      <span class="dock-empty-hint">⤢</span>
      <span class="dock-empty-title">拖面板到此停靠</span>
    </div>
  </div>
</template>

<style scoped>
.dock-zone {
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  overflow: hidden;
  flex-shrink: 0;
}
.dock-zone.left {
  border-right: 1px solid var(--border);
}
.dock-zone.right {
  border-left: 1px solid var(--border);
}
.dock-zone.bottom {
  border-top: 1px solid var(--border);
  width: 100%;
}
/* 拖拽落点高亮（吸附提示，中性强调色） */
.dock-zone.drop-target {
  box-shadow: inset 0 0 0 2px var(--accent);
  background: rgba(117, 117, 117, 0.12);
}
/* 空停靠区（细条拖放落点） */
.dock-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: var(--text-dim);
  font-size: 11px;
  overflow: hidden;
  user-select: none;
}
.dock-empty-hint {
  font-size: 13px;
  line-height: 1;
}
.dock-empty-title {
  white-space: nowrap;
}
/* 左右竖条太窄，只显示图标 */
.dock-zone.left .dock-empty-title,
.dock-zone.right .dock-empty-title {
  display: none;
}
.dock-zone.drop-target .dock-empty {
  color: var(--accent);
}
/* 标签条 */
.dock-tabs {
  display: flex;
  align-items: stretch;
  flex-shrink: 0;
  padding: 0 4px;
  background: var(--bg-panel-2);
  border-bottom: 1px solid var(--border);
  overflow: hidden;
}
.dock-tab {
  position: relative;
  padding: 5px 12px;
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  white-space: nowrap;
  user-select: none;
  transition: color 0.12s, background 0.12s;
}
.dock-tab:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.dock-tab.active {
  color: var(--text);
  border-bottom-color: var(--accent);
  font-weight: 600;
}
/* 拖拽插入位置指示 */
.dock-tab.drop-pos {
  box-shadow: inset 2px 0 0 var(--accent);
}
/* 面板主体 */
.dock-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* 面板填充与滚动（:deep 覆盖各面板根样式；滚动由面板内部区域自行管理） */
.dock-body :deep(.hierarchy),
.dock-body :deep(.inspector),
.dock-body :deep(.console),
.dock-body :deep(.assets) {
  flex: 1;
  min-height: 0;
}
</style>