<script setup lang="ts">
/**
 * 幻灯片浮动工具（画布左下角）：把可见图层当作一页页播放。
 * - 放映开关（▶/■）+ 上一页/下一页 + 页码（循环播放），翻页按钮仅在放映中可用；
 * - 驱动方式：自动播放（按间隔前进）/ 手动控制（按钮或 ←/→）；事件控制为占位项
 *   （待接入逻辑图/外部事件，先以禁用态列出，避免出现半可用模式）；
 * - 切换方式：左右平移 / 上下平移 / 渐入渐出 / 层叠切换（动画由画布给图层挂 class 完成）；
 * - 偏好（模式/切换方式/间隔/收起态）写 whiteboardLayout，跨打开恢复；页码只存内存。
 */
import { computed } from "vue";
import { openContextMenu } from "../../ui-kit/composables/context-menu";
import {
  saveWhiteboardLayout,
  whiteboardLayout,
  type SlideMode,
  type SlideTransition,
} from "../layout";
import {
  slideCount,
  slideCurrent,
  slideDeck,
  slideGo,
  slideGoToPage,
  slideShow,
  slideToggle,
} from "../slide-show";
import {
  CHEVRON_DOWN_ICON,
  CHEVRON_UP_ICON,
  NEXT_ICON,
  PLAY_ICON,
  PREV_ICON,
  STOP_ICON,
} from "../tool-icons";

const slide = slideShow();

const count = computed(() => slideCount());
const current = computed(() => slideCurrent());
/** 翻页需要至少两页；单页时按钮禁用（仍可放映，便于全屏讲解） */
const canPage = computed(() => count.value > 1);
const pageLabel = computed(() => (count.value ? `${Math.min(slide.index + 1, count.value)} / ${count.value}` : "0 / 0"));

const TRANSITIONS: { value: SlideTransition; label: string }[] = [
  { value: "pushX", label: "左右平移" },
  { value: "pushY", label: "上下平移" },
  { value: "fade", label: "渐入渐出" },
  { value: "stack", label: "层叠切换" },
];

const MODES: { value: SlideMode; label: string; hint: string }[] = [
  { value: "auto", label: "自动", hint: "自动播放：按间隔按时长翻页并循环" },
  { value: "manual", label: "手动", hint: "手动控制：点上一页/下一页或按 ← → 翻页" },
];

function setTransition(ev: Event): void {
  whiteboardLayout.slideTransition = (ev.target as HTMLSelectElement).value as SlideTransition;
  saveWhiteboardLayout();
}

function setMode(mode: SlideMode): void {
  whiteboardLayout.slideMode = mode;
  saveWhiteboardLayout();
}

function setIntervalSec(ev: Event): void {
  const v = Math.round(Number((ev.target as HTMLInputElement).value));
  whiteboardLayout.slideInterval = Number.isFinite(v) ? Math.min(60, Math.max(1, v)) : 3;
  saveWhiteboardLayout();
}

function toggleCollapsed(): void {
  whiteboardLayout.slideCollapsed = !whiteboardLayout.slideCollapsed;
  saveWhiteboardLayout();
}

function go(dir: 1 | -1): void {
  if (!slide.active || !canPage.value) return;
  slideGo(dir);
}

/**
 * 页码点开 = 放映页列表：可直接跳到某一页（等同「选择从哪一页开始」）。
 * 用 ui-kit 的 ContextMenu（与全应用同一套浮层外观），不另造弹层。
 */
function openPageList(e: MouseEvent): void {
  const pages = slideDeck();
  if (!pages.length) return;
  openContextMenu(e, [
    { header: true, label: `放映页（共 ${pages.length} 页，点击跳转）` },
    ...pages.map((p, i) => ({
      label: `${i + 1}. ${p.name}${i === slide.index ? "  ✓" : ""}`,
      onClick: () => {
        if (!slide.active) slideToggle(); // 未放映时先起播（从活动图层开始），再跳到所选页
        slideGoToPage(i);
      },
    })),
  ]);
}
</script>

<template>
  <div class="sv-slide-bar" :class="{ collapsed: whiteboardLayout.slideCollapsed }">
    <div class="sv-slide-row">
      <button
        class="sv-slide-play"
        :class="{ active: slide.active }"
        :title="slide.active ? '停止放映（Esc）' : '开始放映：按当前页序播放图层'"
        @click="slideToggle()"
      >
        <svg viewBox="0 0 24 24" width="13" height="13" :fill="slide.active ? 'none' : 'currentColor'" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" v-html="slide.active ? STOP_ICON : PLAY_ICON"></svg>
        <span>{{ slide.active ? "停止" : "放映" }}</span>
      </button>

      <div class="sv-slide-nav">
        <button
          class="sv-slide-btn"
          :disabled="!slide.active || !canPage"
          title="上一页（←）"
          @click="go(-1)"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" v-html="PREV_ICON"></svg>
        </button>
        <button
          class="sv-slide-count"
          :title="`当前页：${current?.name ?? '无可放映图层'}（点击选择要放映的页）`"
          @click="openPageList"
        >
          <b>{{ pageLabel }}</b>
          <i v-if="current">{{ current.name }}</i>
        </button>
        <button
          class="sv-slide-btn"
          :disabled="!slide.active || !canPage"
          title="下一页（→）"
          @click="go(1)"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" v-html="NEXT_ICON"></svg>
        </button>
      </div>

      <button
        class="sv-slide-fold"
        :title="whiteboardLayout.slideCollapsed ? '展开幻灯片设置' : '收起幻灯片设置'"
        @click="toggleCollapsed()"
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" v-html="whiteboardLayout.slideCollapsed ? CHEVRON_UP_ICON : CHEVRON_DOWN_ICON"></svg>
      </button>
    </div>

    <div v-show="!whiteboardLayout.slideCollapsed" class="sv-slide-row sv-slide-opts">
      <label class="sv-slide-field" title="切页动画">
        <span>切换</span>
        <select :value="whiteboardLayout.slideTransition" @change="setTransition">
          <option v-for="t in TRANSITIONS" :key="t.value" :value="t.value">{{ t.label }}</option>
        </select>
      </label>

      <label
        class="sv-slide-field"
        :title="whiteboardLayout.slideMode === 'auto' ? '自动播放间隔（秒）' : '切到自动播放后生效'"
      >
        <span>间隔</span>
        <input
          type="number"
          min="1"
          max="60"
          step="1"
          :value="whiteboardLayout.slideInterval"
          :disabled="whiteboardLayout.slideMode !== 'auto'"
          @change="setIntervalSec"
        />
        <span class="sv-slide-unit">s</span>
      </label>

      <div class="sv-slide-modes" role="group" title="驱动方式">
        <button
          v-for="m in MODES"
          :key="m.value"
          class="sv-slide-mode"
          :class="{ active: whiteboardLayout.slideMode === m.value }"
          :title="m.hint"
          @click="setMode(m.value)"
        >{{ m.label }}</button>
        <button
          class="sv-slide-mode sv-slide-mode-todo"
          disabled
          title="事件控制（占位）：待接入逻辑图/外部事件驱动切页，暂未启用"
        >事件<span class="sv-slide-todo">占位</span></button>
      </div>
    </div>
  </div>
</template>
