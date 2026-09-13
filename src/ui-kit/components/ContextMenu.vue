<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import {
  clampMenuX,
  clampMenuY,
  ctxMenu,
  closeContextMenu,
  pickSubmenuX,
  SUBMENU_LIP,
  type CtxMenuItem,
} from "../composables/context-menu";
import "../styles/components/context-menu.scss";

interface MenuLevel {
  items: CtxMenuItem[];
  x: number;
  y: number;
  anchorRight?: number;
  parentLeft?: number;
}

const levels = ref<MenuLevel[]>([]);
const levelEls: HTMLElement[] = [];

function bindLevelEl(i: number) {
  return (el: unknown) => {
    if (el instanceof HTMLElement) levelEls[i] = el;
  };
}

function hasChildren(item: CtxMenuItem): boolean {
  return !!item.children && item.children.length > 0;
}

async function positionLevel(i: number) {
  await nextTick();
  const lv = levels.value[i];
  const el = levelEls[i];
  if (!lv || !el) return;
  const r = el.getBoundingClientRect();
  lv.y = clampMenuY(lv.y, r.height, window.innerHeight);
  if (i === 0 || lv.parentLeft == null) {
    lv.x = clampMenuX(lv.x, r.width, window.innerWidth);
    return;
  }
  const ancestorRanges: [number, number][] = levels.value
    .slice(0, i - 1)
    .map((_, idx) => levelEls[idx]?.getBoundingClientRect())
    .filter((rect): rect is DOMRect => !!rect)
    .map((rect) => [rect.left, rect.right] as [number, number]);
  lv.x = pickSubmenuX({
    anchorRight: lv.anchorRight ?? lv.x,
    parentLeft: lv.parentLeft,
    width: r.width,
    windowWidth: window.innerWidth,
    ancestorRanges,
  });
}

watch(
  () => [ctxMenu.open, ctxMenu.x, ctxMenu.y, ctxMenu.items],
  async () => {
    if (!ctxMenu.open) {
      levels.value = [];
      return;
    }
    levels.value = [{ items: ctxMenu.items, x: ctxMenu.x, y: ctxMenu.y }];
    await positionLevel(0);
  },
);

function openChild(level: number, item: CtxMenuItem, el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const parentEl = levelEls[level];
  const parentLeft = parentEl ? parentEl.getBoundingClientRect().left : r.left;
  levels.value = [
    ...levels.value.slice(0, level + 1),
    {
      items: item.children!,
      x: r.right - SUBMENU_LIP,
      y: r.top,
      anchorRight: r.right - SUBMENU_LIP,
      parentLeft,
    },
  ];
  void positionLevel(level + 1);
}

function enterItem(level: number, item: CtxMenuItem, target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (el && hasChildren(item)) {
    openChild(level, item, el);
  } else if (levels.value.length > level + 1) {
    levels.value = levels.value.slice(0, level + 1);
  }
}

function run(item: CtxMenuItem, level: number, target: EventTarget | null) {
  if (item.disabled || item.separator) return;
  if (!item.onClick) {
    const el = target as HTMLElement | null;
    if (el && hasChildren(item)) openChild(level, item, el);
    return;
  }
  closeContextMenu();
  item.onClick?.();
}

function onWindowMouseDown(e: MouseEvent) {
  const t = e.target as Element | null;
  if (t && t.closest?.(".ctx-menu")) return;
  closeContextMenu();
}

function onWindowKey(e: KeyboardEvent) {
  if (e.key === "Escape") closeContextMenu();
}

function onWindowBlur() {
  closeContextMenu();
}

function onWindowScroll() {
  closeContextMenu();
}

function onWindowContext() {
  closeContextMenu();
}

watch(
  () => ctxMenu.open,
  (open) => {
    const w = window;
    if (open) {
      w.addEventListener("mousedown", onWindowMouseDown, true);
      w.addEventListener("keydown", onWindowKey);
      w.addEventListener("blur", onWindowBlur);
      w.addEventListener("scroll", onWindowScroll, true);
      w.addEventListener("contextmenu", onWindowContext, true);
      w.addEventListener("resize", onWindowScroll);
    } else {
      w.removeEventListener("mousedown", onWindowMouseDown, true);
      w.removeEventListener("keydown", onWindowKey);
      w.removeEventListener("blur", onWindowBlur);
      w.removeEventListener("scroll", onWindowScroll, true);
      w.removeEventListener("contextmenu", onWindowContext, true);
      w.removeEventListener("resize", onWindowScroll);
    }
  },
);
</script>

<template>
  <Teleport to="body">
    <div v-if="ctxMenu.open" class="ctx-layer">
      <div
        v-for="(lv, L) in levels"
        :key="L"
        :ref="bindLevelEl(L)"
        class="ctx-menu"
        :class="{ 'ctx-sub': L > 0 }"
        role="menu"
        :style="{ left: lv.x + 'px', top: lv.y + 'px' }"
      >
        <template v-for="(item, i) in lv.items" :key="i">
          <div v-if="item.separator" class="ctx-sep"></div>
          <div v-else-if="item.header" class="ctx-header">{{ item.label }}</div>
          <div
            v-else
            class="ctx-item"
            :class="{ disabled: item.disabled, danger: item.danger }"
            role="menuitem"
            :tabindex="-1"
            @mouseenter="enterItem(L, item, $event.currentTarget)"
            @click="run(item, L, $event.currentTarget)"
          >
            <span class="ctx-label">{{ item.label }}</span>
            <span v-if="item.shortcut" class="ctx-shortcut">{{ item.shortcut }}</span>
            <span v-if="hasChildren(item)" class="ctx-arrow">▸</span>
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>