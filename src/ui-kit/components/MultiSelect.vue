<script lang="ts">
/** 选项行：badgeDeleted = "已删除"式占位行（红色警示徽标） */
export interface MultiSelectOption {
  id: string;
  label: string;
  badge?: string;
  badgeDeleted?: boolean;
}
</script>

<script setup lang="ts">
/**
 * 通用多选下拉（浮动菜单）：触发器显示已选摘要（未选 = 占位文案；单个 = 名称；
 * 多个 = 首名 + 等N项），点击弹出 Teleport 浮层勾选列表。
 * - 关闭策略与 ContextMenu 一致：外点 / Escape / 失焦 / 外部容器滚动 / resize；
 *   面板内部滚动（选项列表 overflow）不关闭；
 * - ui-kit 通用组件，不依赖业务数据：候选行由调用方给定（options），勾选即时
 *   上报（保持勾选顺序），支持 v-model:selectedIds。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import "../styles/components/multi-select.scss";

const props = defineProps<{
  /** 已选 id（顺序 = 勾选顺序） */
  selectedIds: string[];
  /** 候选行（含已删除占位行） */
  options: MultiSelectOption[];
  /** 未选中时的占位文案 */
  placeholder?: string;
  /** 未选中时的悬停提示 */
  placeholderTitle?: string;
  /** 候选为空时的空态文案 */
  emptyText?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: "update:selectedIds", ids: string[]): void;
}>();

function labelOf(id: string): string {
  return props.options.find((o) => o.id === id)?.label ?? `${id}（已删除）`;
}

/** 勾选/取消一项（提交整个 id 数组，保持勾选顺序） */
function onToggle(id: string): void {
  const cur = props.selectedIds;
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  emit("update:selectedIds", next);
}

/** 触发器摘要：未选 = 占位；单个 = 名称；多个 = 首名 + 等N项 */
const summary = computed(() => {
  const ids = props.selectedIds;
  if (ids.length === 0) return props.placeholder ?? "未选择";
  if (ids.length === 1) return labelOf(ids[0]);
  return `${labelOf(ids[0])} 等 ${ids.length} 项`;
});

/** 触发器悬停提示（列出全部已选） */
const hint = computed(() => {
  const ids = props.selectedIds;
  if (ids.length === 0) return props.placeholderTitle ?? "未选择";
  return `已选：${ids.map(labelOf).join("、")}`;
});

// —— 浮动菜单（Teleport 到 body；关闭策略与 ContextMenu 一致） ——

const open = ref(false);
const triggerEl = ref<HTMLElement | null>(null);
const panelEl = ref<HTMLElement | null>(null);
const menuPos = ref({ x: 0, y: 0, w: 0 });

/** 打开：按触发器矩形定位（下方空间不足时翻转到上方，nextTick 后量高钳制） */
async function toggleMenu(): Promise<void> {
  if (open.value) {
    closeMenu();
    return;
  }
  const r = triggerEl.value?.getBoundingClientRect();
  if (!r) return;
  menuPos.value = { x: r.left, y: r.bottom + 4, w: r.width };
  open.value = true;
  await nextTick();
  const ph = panelEl.value?.offsetHeight ?? 0;
  if (ph > 0 && menuPos.value.y + ph > window.innerHeight - 8) {
    menuPos.value = { ...menuPos.value, y: Math.max(8, r.top - ph - 4) };
  }
}

function closeMenu(): void {
  open.value = false;
}

/** 外点关闭（mousedown 捕获段；菜单内与触发器上的点击除外） */
function onWindowMouseDown(e: MouseEvent): void {
  const t = e.target as Element | null;
  if (t?.closest?.(".multi-select-menu")) return;
  if (triggerEl.value?.contains(t)) return;
  closeMenu();
}

function onWindowKey(e: KeyboardEvent): void {
  if (e.key === "Escape") closeMenu();
}

// 面板内部滚动（选项列表 overflow）不关闭；仅外部容器滚动关闭（浮层脱钩）
function onWindowScroll(e: Event): void {
  const t = e.target;
  if (t instanceof Element && t.closest(".multi-select-menu")) return;
  closeMenu();
}

function onWindowDismiss(): void {
  closeMenu();
}

watch(open, (v) => {
  const w = window;
  if (v) {
    w.addEventListener("mousedown", onWindowMouseDown, true);
    w.addEventListener("keydown", onWindowKey);
    w.addEventListener("blur", onWindowDismiss);
    w.addEventListener("scroll", onWindowScroll, true);
    w.addEventListener("resize", onWindowDismiss);
  } else {
    w.removeEventListener("mousedown", onWindowMouseDown, true);
    w.removeEventListener("keydown", onWindowKey);
    w.removeEventListener("blur", onWindowDismiss);
    w.removeEventListener("scroll", onWindowScroll, true);
    w.removeEventListener("resize", onWindowDismiss);
  }
});

onBeforeUnmount(closeMenu);
</script>

<template>
  <div class="multi-select">
    <button
      ref="triggerEl"
      type="button"
      class="multi-select-toggle"
      :disabled="disabled"
      :title="hint"
      @click="toggleMenu"
    >
      <span class="multi-select-summary" :data-empty="selectedIds.length === 0">{{ summary }}</span>
      <span class="multi-select-caret" :data-open="open">▾</span>
    </button>
    <Teleport to="body">
      <div
        v-if="open"
        ref="panelEl"
        class="multi-select-menu"
        :style="{ left: menuPos.x + 'px', top: menuPos.y + 'px', width: menuPos.w + 'px' }"
      >
        <label
          v-for="o in options"
          :key="o.id"
          class="multi-select-row"
          :title="o.badgeDeleted ? `${o.label}（已删除，取消勾选移除）` : o.label"
        >
          <input
            type="checkbox"
            :checked="selectedIds.includes(o.id)"
            :disabled="disabled"
            @change="onToggle(o.id)"
          />
          <span class="multi-select-name">{{ o.label }}</span>
          <span v-if="o.badge" class="multi-select-kind" :data-deleted="o.badgeDeleted">{{ o.badge }}</span>
        </label>
        <div v-if="options.length === 0" class="multi-select-empty">{{ emptyText ?? "无可选项" }}</div>
      </div>
    </Teleport>
  </div>
</template>
