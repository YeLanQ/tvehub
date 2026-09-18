<script setup lang="ts">
/**
 * 通用可编辑下拉（单选 + 边输边过滤）：输入框 + Teleport 浮层候选列表。
 * 原生 <input list> datalist 的 ui-kit 统一替代（系统风格弹层与面板视觉不符）。
 * - 触发 = 聚焦输入框（展示全量候选）或点右侧 ▾ 切换；输入时按包含匹配过滤；
 * - 提交时机与原生 input @change 一致：点候选行 / Enter / 失焦（内容有变化）
 *   → emit update:modelValue；编辑过程不外溢（宿主按提交压快照）；
 * - 候选之外仍可手填任意值（候选只覆盖常用项，高级取值手输）；
 * - 关闭策略与 MultiSelect/ContextMenu 一致：外点 / Escape / 窗口失焦 /
 *   外部容器滚动 / resize；面板内部滚动（候选列表 overflow）不关闭。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import "../styles/components/combo-box.scss";

const props = defineProps<{
  /** 当前值（受控；提交时更新） */
  modelValue: string;
  /** 候选列表（字符串项） */
  options: string[];
  /** 占位提示（悬停 title 同步） */
  placeholder?: string;
  /** 过滤无命中时的空态文案 */
  emptyText?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
}>();

const inputEl = ref<HTMLInputElement | null>(null);
const panelEl = ref<HTMLElement | null>(null);
const open = ref(false);
const text = ref(props.modelValue ?? "");
/** 键盘活动行（-1 = 无） */
const activeIdx = ref(-1);

// 外部值变化同步显示（输入框聚焦中的草稿态不打断编辑）
watch(
  () => props.modelValue,
  (v) => {
    if (document.activeElement !== inputEl.value) text.value = v ?? "";
  },
);

/** 过滤后的候选（空输入 = 全量） */
const filtered = computed<string[]>(() => {
  const q = text.value.trim().toLowerCase();
  if (!q) return props.options;
  return props.options.filter((o) => o.toLowerCase().includes(q));
});

/** 提交一个值（候选行 / Enter / 失焦共用） */
function commit(v: string): void {
  const next = v.trim();
  text.value = next;
  if (next !== props.modelValue) emit("update:modelValue", next);
}

function commitDraft(): void {
  commit(text.value);
}

// ----- 浮动菜单（Teleport 到 body；关闭策略与 MultiSelect 一致） -----

const menuPos = ref({ x: 0, y: 0, w: 0 });

async function openMenu(): Promise<void> {
  if (open.value || props.disabled) return;
  const r = inputEl.value?.getBoundingClientRect();
  if (!r) return;
  const w = Math.max(r.width, 180);
  const x = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
  menuPos.value = { x, y: r.bottom + 4, w };
  activeIdx.value = -1;
  open.value = true;
  await nextTick();
  const ph = panelEl.value?.offsetHeight ?? 0;
  if (ph > 0 && menuPos.value.y + ph > window.innerHeight - 8) {
    menuPos.value = { ...menuPos.value, y: Math.max(8, r.top - ph - 4) };
  }
}

function closeMenu(): void {
  open.value = false;
  activeIdx.value = -1;
}

function toggleMenu(): void {
  if (open.value) {
    closeMenu();
    return;
  }
  inputEl.value?.focus();
  void openMenu();
}

function onWindowMouseDown(e: MouseEvent): void {
  const t = e.target as Element | null;
  if (t?.closest?.(".combo-box-menu")) return;
  if (inputEl.value?.contains(t)) return;
  closeMenu();
}

function onWindowKey(e: KeyboardEvent): void {
  if (e.key === "Escape") closeMenu();
}

// 面板内部滚动（候选列表 overflow）不关闭；仅外部容器滚动关闭（浮层脱钩）
function onWindowScroll(e: Event): void {
  const t = e.target;
  if (t instanceof Element && t.closest(".combo-box-menu")) return;
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

// ----- 键盘导航 -----

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!open.value) void openMenu();
    const n = filtered.value.length;
    if (!n) return;
    e.preventDefault();
    activeIdx.value =
      e.key === "ArrowDown"
        ? (activeIdx.value + 1) % n
        : activeIdx.value <= 0
          ? n - 1
          : activeIdx.value - 1;
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    const hit = activeIdx.value >= 0 ? filtered.value[activeIdx.value] : undefined;
    commit(hit ?? text.value);
    closeMenu();
    return;
  }
  if (e.key === "Escape" && open.value) {
    e.preventDefault(); // 浮层打开时 Esc 只关浮层，不冒泡给宿主（如删除选区）
    text.value = props.modelValue ?? "";
    closeMenu();
  }
}

function onInput(e: Event): void {
  text.value = (e.target as HTMLInputElement).value;
  activeIdx.value = -1;
  if (!open.value) void openMenu();
}

function onPick(v: string): void {
  commit(v);
  closeMenu();
}
</script>

<template>
  <div class="combo-box">
    <input
      ref="inputEl"
      class="combo-box-input"
      type="text"
      :value="text"
      :placeholder="placeholder ?? ''"
      :title="placeholder ? `${text || placeholder}\n${placeholder}` : text || undefined"
      :disabled="disabled"
      autocomplete="off"
      spellcheck="false"
      @focus="openMenu()"
      @blur="commitDraft()"
      @input="onInput"
      @keydown="onKeydown"
    />
    <button
      type="button"
      class="combo-box-caret"
      tabindex="-1"
      :disabled="disabled"
      :data-open="open"
      title="候选列表"
      @mousedown.prevent
      @click="toggleMenu"
    >▾</button>
    <Teleport to="body">
      <div
        v-if="open"
        ref="panelEl"
        class="combo-box-menu"
        :style="{ left: menuPos.x + 'px', top: menuPos.y + 'px', width: menuPos.w + 'px' }"
      >
        <div
          v-for="(o, i) in filtered"
          :key="o"
          class="combo-box-row"
          :data-active="i === activeIdx"
          :title="o"
          @mousedown.prevent
          @click="onPick(o)"
        >
          <span class="combo-box-name">{{ o }}</span>
          <span v-if="o === modelValue" class="combo-box-check">✓</span>
        </div>
        <div v-if="filtered.length === 0" class="combo-box-empty">{{ emptyText ?? "无匹配候选（可直接输入）" }}</div>
      </div>
    </Teleport>
  </div>
</template>
