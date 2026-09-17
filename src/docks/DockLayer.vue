<script setup lang="ts">
/**
 * 停靠系统顶层胶水层（编辑器/图窗口共用），置于应用根节点下：
 * 浮动面板 + 拖拽幽灵（跟随鼠标的面板标签）+ 拖拽捕获层
 * （盖住 iframe 等吞掉鼠标事件的区域）+ 落点实时预览。
 */
import { computed, type Component } from "vue";
import FloatingDock from "./FloatingDock.vue";
import type { DockSystem } from "./types";

const props = defineProps<{
  sys: DockSystem<string>;
  panels: Record<string, Component>;
}>();

/** 拖拽预览位置：落点停靠区的矩形 */
const previewStyle = computed(() => {
  const t = props.sys.dnd.target;
  if (!t || t.kind !== "zone") return null;
  const el = document.querySelector<HTMLElement>(`.dock-zone.${t.zone}`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  };
});

/** 拖拽预览的面板组件（无映射时 null） */
const previewComp = computed(() =>
  props.sys.dnd.panel ? (props.panels[props.sys.dnd.panel] ?? null) : null,
);
</script>

<template>
  <!-- 浮动窗口（拖出停靠区的面板） -->
  <FloatingDock v-for="f in sys.layout.floating" :key="f.id" :sys="sys" :win="f" :panels="panels" />

  <!-- 拖拽幽灵（跟随鼠标的面板标签；仅实际拖拽时显示） -->
  <div
    v-if="sys.dnd.active && sys.dnd.moved && sys.dnd.panel"
    class="dock-ghost"
    :style="{ left: sys.dnd.clientX + 'px', top: sys.dnd.clientY + 'px' }"
  >
    {{ sys.labels[sys.dnd.panel] }}
  </div>
  <!-- 拖拽捕获层：仅实际拖拽时渲染 -->
  <div v-if="sys.dnd.active && sys.dnd.moved" class="dock-drag-overlay"></div>

  <!-- 拖拽预览：落点位置实时显示面板内容 -->
  <div
    v-if="sys.dnd.active && sys.dnd.moved && previewComp && previewStyle"
    class="dock-preview"
    :style="previewStyle"
  >
    <component :is="previewComp" />
  </div>
</template>
