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
import AnimationEditorPanel from "./AnimationEditorPanel.vue";
import "../../styles/components/dock-zone.scss";

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
      <AnimationEditorPanel v-if="activePanel === 'animation'" />
    </div>
    </template>
    <!-- 空停靠区：细条拖放落点（拖回面板停靠） -->
    <div v-else class="dock-empty">
      <span class="dock-empty-hint">⤢</span>
      <span class="dock-empty-title">拖面板到此停靠</span>
    </div>
  </div>
</template>
