<script setup lang="ts">
/**
 * Culling Mask 控件（Unity 同名语义，相机/灯光共用）：
 * - 折叠态：按钮回显掩码摘要（Everything / Nothing / 逗号分隔层名）；
 * - 点击弹出下拉菜单：菜单 Teleport 到 body 用 fixed 定位——检查器卡片是
 *   overflow:hidden 的滚动容器，内嵌浮层会被裁剪；按钮下方空间不足时自动
 *   上翻；滚动/缩放/点击外部关闭；
 * - 菜单内容：Everything / Nothing 快捷档 + 项目层表中已定义的层逐行勾选
 *   （单行不换行；未定义的层不显示）；变更即 emit change(新掩码)。
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { getProjectStore } from "../stores/project";
import {
  ALL_LAYERS_MASK,
  MASK_EVERYTHING_LABEL,
  MASK_NOTHING_LABEL,
  cullingMaskLabel,
  definedLayerIndices,
  layerNameAt,
  maskHasLayer,
  maskWithLayer,
} from "../../framework/layers";

const props = defineProps<{ mask: number; rev?: number }>();

const emit = defineEmits<{ change: [mask: number] }>();

const projectStore = getProjectStore();
const btn = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const open = ref(false);
/** 菜单浮层样式（打开时按按钮屏幕位置计算；fixed 定位不受卡片裁剪） */
const popStyle = ref<{ left: string; top: string; width: string }>({
  left: "0px",
  top: "0px",
  width: "180px",
});

/** 当前掩码（以 rev 为失效信号：撤销/重做/属性补丁后重算） */
const current = computed(() => {
  void props.rev;
  return props.mask;
});

const summary = computed(() => cullingMaskLabel(projectStore.layers, current.value));

/** 勾选行：仅项目层表中已定义的层（未定义层位不显示，Everything 语义照常覆盖） */
const rows = computed(() =>
  definedLayerIndices(projectStore.layers).map((i) => ({
    index: i,
    name: layerNameAt(projectStore.layers, i),
    on: maskHasLayer(current.value, i),
  })),
);

/** 勾选后归一化：已定义层全部覆盖 → 存 -1（Everything）；一个都不覆盖 → 存 0
 * （Nothing）。这样「勾满所有层」的回显就是 Everything，存储值也干净。 */
function normalize(mask: number): number {
  const defined = definedLayerIndices(projectStore.layers);
  const covered = defined.filter((i) => maskHasLayer(mask, i)).length;
  if (defined.length > 0 && covered === defined.length) return ALL_LAYERS_MASK;
  if (covered === 0) return 0;
  return mask;
}

const MENU_GAP = 2;
const MENU_MAX_H = 220;

function openMenu(): void {
  const r = btn.value?.getBoundingClientRect();
  if (!r) return;
  const width = Math.max(r.width, 180);
  const left = Math.min(r.left, window.innerWidth - width - 4);
  // 下方放不下且上方充裕 → 上翻（菜单高度按 8 行估；实际可滚动）
  const below = window.innerHeight - r.bottom;
  const top =
    below < MENU_MAX_H && r.top > MENU_MAX_H
      ? Math.max(4, r.top - MENU_MAX_H - MENU_GAP)
      : r.bottom + MENU_GAP;
  popStyle.value = { left: `${Math.max(4, left)}px`, top: `${top}px`, width: `${width}px` };
  open.value = true;
}

function toggleMenu(): void {
  if (open.value) close();
  else openMenu();
}

function close(): void {
  open.value = false;
}

function onDocMouseDown(e: MouseEvent): void {
  const t = e.target as Node;
  if (btn.value?.contains(t) || menu.value?.contains(t)) return;
  close();
}

function onReflow(): void {
  if (open.value) close();
}

watch(open, (v) => {
  if (v) {
    document.addEventListener("mousedown", onDocMouseDown);
    window.addEventListener("resize", onReflow);
    // 检查器/卡片滚动时关闭（fixed 菜单不随文档滚动，保持对齐最简单）
    window.addEventListener("scroll", onReflow, true);
  } else {
    document.removeEventListener("mousedown", onDocMouseDown);
    window.removeEventListener("resize", onReflow);
    window.removeEventListener("scroll", onReflow, true);
  }
});

onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocMouseDown);
  window.removeEventListener("resize", onReflow);
  window.removeEventListener("scroll", onReflow, true);
});

function toggle(index: number, on: boolean): void {
  emit("change", normalize(maskWithLayer(current.value, index, on)));
}

function setAll(): void {
  emit("change", ALL_LAYERS_MASK);
}

function setNone(): void {
  emit("change", 0);
}
</script>

<template>
  <div class="culling-mask" :data-rev="rev">
    <button ref="btn" type="button" class="culling-mask-btn" :title="`Culling Mask：${summary}`" @click="toggleMenu">
      <span class="culling-mask-summary">{{ summary }}</span>
      <span class="culling-mask-caret">{{ open ? "▾" : "▸" }}</span>
    </button>
    <Teleport to="body">
      <div v-if="open" ref="menu" class="culling-mask-pop" :style="popStyle">
        <div class="culling-mask-quick">
          <button type="button" @click="setAll">{{ MASK_EVERYTHING_LABEL }}</button>
          <button type="button" @click="setNone">{{ MASK_NOTHING_LABEL }}</button>
        </div>
        <label v-for="r in rows" :key="r.index" class="culling-mask-row">
          <input
            type="checkbox"
            :checked="r.on"
            @change="toggle(r.index, ($event.target as HTMLInputElement).checked)"
          />
          <span class="culling-mask-index">{{ r.index }}</span>
          <span class="culling-mask-name">{{ r.name }}</span>
        </label>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.culling-mask {
  flex: 1;
  min-width: 0;
}
.culling-mask-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 4px 6px;
  font-size: 12px;
  color: var(--text, #ddd);
  background: var(--bg, #222);
  border: 1px solid var(--border, #444);
  border-radius: 4px;
  cursor: pointer;
  text-align: left;
}
.culling-mask-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.culling-mask-caret {
  flex: 0 0 auto;
  color: var(--text-dim, #888);
  font-size: 10px;
}
/* 浮层 Teleport 到 body（fixed 定位），不受检查器卡片 overflow:hidden 裁剪 */
.culling-mask-pop {
  position: fixed;
  z-index: 1000;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 220px;
  overflow-y: auto;
  background: var(--bg, #222);
  border: 1px solid var(--border, #444);
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}
.culling-mask-quick {
  display: flex;
  gap: 6px;
  padding-bottom: 4px;
  margin-bottom: 2px;
  border-bottom: 1px solid var(--border, #444);
}
.culling-mask-quick button {
  flex: 1;
  padding: 2px 6px;
  font-size: 11px;
  color: var(--text, #ddd);
  background: transparent;
  border: 1px solid var(--border, #444);
  border-radius: 3px;
  cursor: pointer;
}
.culling-mask-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.culling-mask-index {
  flex: 0 0 16px;
  font-size: 10px;
  color: var(--text-dim, #888);
  text-align: center;
}
.culling-mask-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
