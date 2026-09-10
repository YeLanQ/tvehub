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
} from "../lib/editor/context-menu";
import "../styles/components/context-menu.scss";

/** 一层菜单：items 内容 + 当前所处的视口锚点 */
interface MenuLevel {
  items: CtxMenuItem[];
  x: number;
  y: number;
  /** 展开锚点（仅子级）：父菜单右边缘（默认展开侧）与左边缘（右溢出时翻到其左侧） */
  anchorRight?: number;
  parentLeft?: number;
}

// levels[0] 为根菜单，后续每层对应一个已展开的子菜单（由 hover 链驱动）
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

/**
 * 一层菜单定位（渲染后按实测尺寸收敛）：
 * - 垂直：贴锚点，越出窗口下/上边则收回窗口内；
 * - 水平：根级贴鼠标并收进窗口；子级在「贴父菜单右侧 / 翻到父菜单左侧」两个候选里优选
 *   （几何规则见 lib/editor/context-menu.ts 的 pickSubmenuX）——子菜单不会盖住它的上一级，
 *   也尽量避免覆盖其它已展开层级。
 */
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
  // 其它已展开层级（不含直接父级）的水平区间：避免子菜单盖住它们
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
  // 展开/切换子菜单：仅保留到当前层，再追加新的下一层
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
    // 移到无子级的项上：收起其后所有层级
    levels.value = levels.value.slice(0, level + 1);
  }
}

function run(item: CtxMenuItem, level: number, target: EventTarget | null) {
  if (item.disabled || item.separator) return;
  if (!item.onClick) {
    // 无动作的子菜单父项：点击展开其子菜单而不是收起整个菜单
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
