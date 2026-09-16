<script setup lang="ts">
/**
 * 脚本图窗口停靠区（编辑器 DockZone 的图窗口版，槽位化）：
 * 页签拖拽（移动/停靠/浮动）、点击激活、空区细条落点与编辑器一致；
 * 面板内容由父级按页签名具名插槽提供（图窗口面板：hierarchy/inspector/assets）。
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  activate,
  graphDocks,
  GRAPH_DOCK_PANEL_LABEL,
  type GraphDockPanelId,
  type GraphDockZoneId,
} from "../docks";
import { beginTabDrag, graphDockDnd, registerZoneEl } from "../graph-dock-dnd";
import "../../styles/components/dock-zone.scss";

const props = defineProps<{ zone: GraphDockZoneId }>();

const el = ref<HTMLElement | null>(null);

const panels = computed(() => graphDocks.zones[props.zone]);
/** 当前激活面板（区域为空时 null） */
const activePanel = computed(() => {
  const a = graphDocks.active[props.zone];
  return panels.value.includes(a) ? a : (panels.value[0] ?? null);
});

const zoneStyle = computed(() => {
  // 空区：折叠成细条（仍是拖放落点，可拖回面板停靠）；非空按 sizes
  const empty = panels.value.length === 0;
  if (props.zone === "bottom") return { height: `${empty ? 14 : graphDocks.sizes.bottom}px` };
  return { width: `${empty ? 14 : graphDocks.sizes[props.zone]}px` };
});

/** 拖拽落点高亮：仅实际拖拽（moved）时显示 */
const isDropTarget = computed(
  () =>
    graphDockDnd.active &&
    graphDockDnd.moved &&
    graphDockDnd.target?.kind === "zone" &&
    graphDockDnd.target.zone === props.zone,
);

/** 标签插入位置（落点索引对应的标签显示左侧插入线） */
const insertIndex = computed(() => (isDropTarget.value ? graphDockDnd.target!.index : -1));

function onTabDown(e: MouseEvent, panelId: GraphDockPanelId) {
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
          {{ GRAPH_DOCK_PANEL_LABEL[p] }}
        </div>
      </div>
      <div class="dock-body">
        <!-- v-if：同一面板只存在一个实例，避免状态不同步 -->
        <slot v-if="activePanel" :name="activePanel"></slot>
      </div>
    </template>
    <!-- 空停靠区：细条拖放落点（拖回面板停靠） -->
    <div v-else class="dock-empty">
      <span class="dock-empty-hint">⤢</span>
      <span class="dock-empty-title">拖面板到此停靠</span>
    </div>
  </div>
</template>
