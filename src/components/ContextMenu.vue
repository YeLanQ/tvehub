<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import {
  ctxMenu,
  closeContextMenu,
  type CtxMenuItem,
} from "../lib/editor/context-menu";

const rootEl = ref<HTMLElement | null>(null);
const subEl = ref<HTMLElement | null>(null);
const pos = reactive({ x: 0, y: 0 });
const subPos = reactive({ x: 0, y: 0 });
const subIndex = ref<number | null>(null);

const subItems = computed<CtxMenuItem[]>(() => {
  if (subIndex.value == null) return [];
  const item = ctxMenu.items[subIndex.value];
  return item?.children ?? [];
});

function clampRect(el: HTMLElement, p: { x: number; y: number }, margin = 8) {
  const r = el.getBoundingClientRect();
  let x = p.x;
  let y = p.y;
  if (x + r.width > window.innerWidth - margin)
    x = Math.max(margin, window.innerWidth - r.width - margin);
  if (y + r.height > window.innerHeight - margin)
    y = Math.max(margin, window.innerHeight - r.height - margin);
  p.x = x;
  p.y = y;
}

watch(
  () => ctxMenu.open,
  async (open) => {
    if (!open) return;
    subIndex.value = null;
    pos.x = ctxMenu.x;
    pos.y = ctxMenu.y;
    await nextTick();
    if (rootEl.value) clampRect(rootEl.value, pos);
  },
);

watch(subIndex, async (idx) => {
  if (idx == null) return;
  await nextTick();
  if (subEl.value) clampRect(subEl.value, subPos);
});

function enterItem(i: number, target: EventTarget | null) {
  const item = ctxMenu.items[i];
  const el = target as HTMLElement | null;
  if (el && item.children && item.children.length > 0) {
    const r = el.getBoundingClientRect();
    subPos.x = r.right - 2;
    subPos.y = r.top;
    subIndex.value = i;
  } else {
    subIndex.value = null;
  }
}

function run(item: CtxMenuItem) {
  if (item.disabled || item.separator) return;
  closeContextMenu();
  item.onClick?.();
}

function onWindowMouseDown(e: MouseEvent) {
  const t = e.target as Node | null;
  if (rootEl.value?.contains(t) || subEl.value?.contains(t)) return;
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
        ref="rootEl"
        class="ctx-menu"
        role="menu"
        :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
      >
        <template v-for="(item, i) in ctxMenu.items" :key="i">
          <div v-if="item.separator" class="ctx-sep"></div>
          <div v-else-if="item.header" class="ctx-header">{{ item.label }}</div>
          <div
            v-else
            class="ctx-item"
            :class="{ disabled: item.disabled, danger: item.danger }"
            role="menuitem"
            :tabindex="-1"
            @mouseenter="enterItem(i, $event.currentTarget)"
            @click="run(item)"
          >
            <span class="ctx-label">{{ item.label }}</span>
            <span v-if="item.shortcut" class="ctx-shortcut">{{ item.shortcut }}</span>
            <span v-if="item.children && item.children.length > 0" class="ctx-arrow">▸</span>
          </div>
        </template>
      </div>

      <div
        v-if="subItems.length > 0"
        ref="subEl"
        class="ctx-menu ctx-sub"
        role="menu"
        :style="{ left: subPos.x + 'px', top: subPos.y + 'px' }"
      >
        <template v-for="(item, i) in subItems" :key="i">
          <div v-if="item.separator" class="ctx-sep"></div>
          <div v-else-if="item.header" class="ctx-header">{{ item.label }}</div>
          <div
            v-else
            class="ctx-item"
            :class="{ disabled: item.disabled, danger: item.danger }"
            role="menuitem"
            :tabindex="-1"
            @click="run(item)"
          >
            <span class="ctx-label">{{ item.label }}</span>
            <span v-if="item.shortcut" class="ctx-shortcut">{{ item.shortcut }}</span>
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ctx-layer {
  position: fixed;
  inset: 0;
  z-index: 10000;
  pointer-events: none;
}
.ctx-menu {
  position: fixed;
  min-width: 190px;
  padding: 4px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.5);
  pointer-events: auto;
  user-select: none;
}
.ctx-sub {
  z-index: 1;
}
.ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-radius: 3px;
  cursor: pointer;
  white-space: nowrap;
  color: var(--text);
}
.ctx-item:hover {
  background: var(--bg-active);
  color: #fff;
}
.ctx-item.disabled {
  opacity: 0.45;
  pointer-events: none;
}
.ctx-item.danger:hover {
  background: var(--err);
}
.ctx-label {
  flex: 1;
  font-size: 12px;
}
.ctx-shortcut {
  color: var(--text-dim);
  font-size: 11px;
}
.ctx-item:hover .ctx-shortcut {
  color: rgba(255, 255, 255, 0.75);
}
.ctx-arrow {
  color: var(--text-dim);
  font-size: 10px;
}
.ctx-header {
  padding: 5px 10px 2px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--text-dim);
  user-select: none;
  white-space: nowrap;
}
.ctx-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--border);
}
</style>