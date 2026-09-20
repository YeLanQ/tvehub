<script setup lang="ts">
/**
 * 白板窗口壳（全局单例：Tauri 窗口 label "whiteboard"，whiteboard-main.ts 启动；
 * 与首页同级的全局工具窗口，不绑定项目，文档存全局白板目录）：
 * 顶部标题栏（文件 + 保存 + 撤销重做 + 动画播放 + 窗口控制，可拖拽移动窗口）、
 * 工具条（绘制工具 + 视图适应）、中央画布 + 右侧面板（图层/属性/动画）、
 * 底部状态条。快捷键：V/R/O/L/P/B/T 切工具、Delete 删除、Ctrl+Z/Y 撤销重做、
 * Ctrl+S 保存、Enter 结束钢笔（开放路径）、Esc 取消（文本焦点时让位）；
 * 幻灯片放映中：←/→（含 ↑/↓、PageUp/PageDown）翻页、Esc 退出放映。
 */
import { nextTick, computed, onMounted, onUnmounted, ref } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import WindowControls from "../ui-kit/components/WindowControls.vue";
import Slider from "../ui-kit/components/Slider.vue";
import ContextMenu from "../ui-kit/components/ContextMenu.vue";
import ToastHost from "../ui-kit/components/ToastHost.vue";
import { isTauri } from "../lib/tauri-env";
import { isEditingText } from "../app/commands/context";
import { groupResolutionPresets, matchResolutionPreset } from "../app/lib/project-settings";
import { getWhiteboardStore } from "./whiteboardStore";
import {
  loadWhiteboardLayout,
  saveWhiteboardLayout,
  whiteboardLayout,
  type WhiteboardSideTab,
} from "./layout";
import { TOOL_ICONS, type ToolIconKey } from "./tool-icons";
import WhiteboardStage from "./components/WhiteboardStage.vue";
import WhiteboardLayersPanel from "./components/WhiteboardLayersPanel.vue";
import WhiteboardPropsPanel from "./components/WhiteboardPropsPanel.vue";
import WhiteboardSlideBar from "./components/WhiteboardSlideBar.vue";
import { slideGo, slideShow, slideStop } from "./slide-show";

const store = getWhiteboardStore();
const inTauri = isTauri();
const stageRef = ref<InstanceType<typeof WhiteboardStage> | null>(null);
/** 幻灯片放映态（快捷键分支与状态条提示读它） */
const slide = slideShow();


// ---------------------------------------------------------------------------
// 浮动面板：布局持久化（whiteboardLayout）。位置 null = 默认右上锚定；
// 拖动把手移动（范围钳制在画布内），变更经 saveWhiteboardLayout 防抖落盘。
// ---------------------------------------------------------------------------
interface PanelDrag {
  startX: number;
  startY: number;
  baseX: number;
  baseY: number;
  wrapW: number;
  wrapH: number;
  panelW: number;
}
let panelDrag: PanelDrag | null = null;

const panelStyle = computed(() =>
  whiteboardLayout.panelX != null && whiteboardLayout.panelY != null
    ? { left: `${whiteboardLayout.panelX}px`, top: `${whiteboardLayout.panelY}px`, right: "auto" }
    : undefined,
);

function setSideTab(tab: WhiteboardSideTab): void {
  whiteboardLayout.sideTab = tab;
  saveWhiteboardLayout();
}

function togglePanelCollapsed(): void {
  whiteboardLayout.panelCollapsed = !whiteboardLayout.panelCollapsed;
  saveWhiteboardLayout();
}

function onPanelDragDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  const host = (e.currentTarget as HTMLElement).closest(".sv-float-panel") as HTMLElement | null;
  const wrap = host?.parentElement as HTMLElement | null;
  if (!host || !wrap) return;
  e.preventDefault();
  const hostRect = host.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  if (whiteboardLayout.panelX == null || whiteboardLayout.panelY == null) {
    // 首次拖动：把 CSS 右上锚定换算成 left/top
    whiteboardLayout.panelX = hostRect.left - wrapRect.left;
    whiteboardLayout.panelY = hostRect.top - wrapRect.top;
  }
  panelDrag = {
    startX: e.clientX,
    startY: e.clientY,
    baseX: whiteboardLayout.panelX,
    baseY: whiteboardLayout.panelY,
    wrapW: wrapRect.width,
    wrapH: wrapRect.height,
    panelW: hostRect.width,
  };
  window.addEventListener("pointermove", onPanelDragMove);
  window.addEventListener("pointerup", onPanelDragUp, { once: true });
}

function onPanelDragMove(e: PointerEvent): void {
  if (!panelDrag) return;
  // 钳制：面板至少保留 48px 在画布内，顶端不越界
  whiteboardLayout.panelX = Math.min(
    Math.max(panelDrag.baseX + (e.clientX - panelDrag.startX), 8 - panelDrag.panelW + 48),
    panelDrag.wrapW - 48,
  );
  whiteboardLayout.panelY = Math.min(
    Math.max(panelDrag.baseY + (e.clientY - panelDrag.startY), 4),
    panelDrag.wrapH - 40,
  );
  saveWhiteboardLayout();
}

function onPanelDragUp(): void {
  panelDrag = null;
  window.removeEventListener("pointermove", onPanelDragMove);
}

const TOOLS: { key: Exclude<ToolIconKey, "fit">; title: string }[] = [
  { key: "select", title: "选择/移动（V）" },
  { key: "rect", title: "矩形：拖拽绘制（R）" },
  { key: "ellipse", title: "椭圆：拖拽绘制（O）" },
  { key: "line", title: "直线：拖拽绘制（L）" },
  { key: "pencil", title: "铅笔：自由绘制（P）" },
  { key: "pen", title: "钢笔：单击=直角点，按住拖拽=曲线点，Enter 结束（开放），双击闭合，Esc 取消（B）" },
  { key: "text", title: "文本：点击落点创建，属性面板写内容与 [b]/[i]/[u]/[color=#hex] 语法（T）" },
];

/** 线条工具（直线/铅笔/钢笔）显示粗细滑动条 */
const showWidthSlider = computed(() =>
  ["line", "pencil", "pen"].includes(store.state.tool),
);

function setToolWidth(v: number): void {
  whiteboardLayout.toolWidth = Math.min(24, Math.max(1, v));
  saveWhiteboardLayout();
}

// 白板尺寸下拉（选项与项目设置的「设计分辨率」一致，另支持自定义宽高）
const resolutionGroups = groupResolutionPresets();
const resolutionPreset = computed(() => matchResolutionPreset(store.state.doc.w, store.state.doc.h));
const sizeCustomizing = ref(false);
const customW = ref(1280);
const customH = ref(720);

function onSizeSelect(label: string): void {
  if (label === "__custom__") {
    customW.value = store.state.doc.w;
    customH.value = store.state.doc.h;
    sizeCustomizing.value = true;
    return;
  }
  applySizeLabel(label);
}

function applySizeLabel(label: string): void {
  const hit = resolutionGroups
    .flatMap(([, items]) => items)
    .find((it) => it.label === label);
  if (!hit) return;
  store.setDocSize(hit.width, hit.height);
  fitStage();
}

function applyCustomSize(): void {
  const w = Math.max(1, Math.min(8192, Math.round(customW.value || 0)));
  const h = Math.max(1, Math.min(8192, Math.round(customH.value || 0)));
  store.setDocSize(w, h);
  sizeCustomizing.value = false;
  fitStage();
}

/** 状态条操作提示（放映中最优先，其次随工具切换） */
const toolHint = computed(() => {
  if (slide.active) return "放映中：← → 翻页 · Esc 退出";
  switch (store.state.tool) {
    case "pen":
      return "单击=直角点 · 拖拽=曲线 · Enter 结束 · 双击闭合";
    case "text":
      return "点击画布创建文本 · 内容支持 [b]/[i]/[u]/[color=#hex] 富文本语法";
    default:
      return "滚轮缩放 · 空格/中键拖拽平移";
  }
});

/** 工具栏空白区域 mousedown：启动窗口原生拖拽 */
function onDragDown(e: MouseEvent): void {
  if (!inTauri || e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (target.closest("button, input, select, .project-info")) return;
  void getCurrentWindow().startDragging();
}

/** 双击标题栏空白切换最大化 */
function onDragDblClick(e: MouseEvent): void {
  if (!inTauri) return;
  const target = e.target as HTMLElement;
  if (target.closest("button, input, select, .project-info")) return;
  void getCurrentWindow().toggleMaximize();
}

function fitStage(): void {
  stageRef.value?.fitView();
}

/** 窗口级快捷键（捕获阶段；文本输入焦点时仅保留 Ctrl 组合） */
function onKeydown(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey;
  if (mod) {
    if (isEditingText() && e.key.toLowerCase() !== "s") return;
    const k = e.key.toLowerCase();
    if (k === "z") {
      e.preventDefault();
      if (e.shiftKey) store.redo();
      else store.undo();
    } else if (k === "y") {
      e.preventDefault();
      store.redo();
    } else if (k === "s") {
      e.preventDefault();
      void store.save();
    }
    return;
  }
  if (isEditingText()) return;
  // 放映中：方向键/翻页键切页、Esc 退出；其余编辑快捷键整体让位
  if (slide.active) {
    if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown") {
      e.preventDefault();
      slideGo(1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp") {
      e.preventDefault();
      slideGo(-1);
    } else if (e.key === "Escape") {
      slideStop();
    }
    return;
  }
  const k = e.key.toLowerCase();
  const toolKeys: Record<string, "select" | "rect" | "ellipse" | "line" | "pencil" | "pen" | "text"> = {
    v: "select", r: "rect", o: "ellipse", l: "line", p: "pencil", b: "pen", t: "text",
  };
  if (toolKeys[k]) {
    store.setTool(toolKeys[k]);
    return;
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    // 选中曲线且点选了锚点 → 删锚点；否则删元素
    if (!stageRef.value?.deleteActiveAnchor()) store.deleteSelected();
  } else if (e.key === "Enter" && store.state.tool === "pen") {
    stageRef.value?.penFinish(false);
  } else if (e.key === "Escape") {
    if (store.state.tool === "pen") stageRef.value?.penCancel();
    else store.setTool("select");
  }
}

onMounted(async () => {
  // 恢复上次布局（面板位置/收起态/页签；ui-state KV 全局键）
  void loadWhiteboardLayout();
  window.addEventListener("keydown", onKeydown, true);
  if (inTauri) {
    // 窗口由 Rust 动态创建时隐藏：等首帧呈现后再 show（双 rAF 等合成器提交，
    // 隐藏窗口 rAF 被节流时由超时兜底；原生背景色为深色不露白）
    await nextTick();
    await Promise.race([
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
      new Promise<void>((resolve) => setTimeout(resolve, 250)),
    ]);
    void getCurrentWindow().show().catch(() => {});
  }
});

onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown, true);
  window.removeEventListener("pointermove", onPanelDragMove);
});
</script>

<template>
  <div class="svg-app" @contextmenu.prevent>
    <!-- 浏览器直开降级提示（完整界面可用，白板存取不可用） -->
    <div v-if="store.state.degraded" class="sv-degraded">
      白板窗口需在桌面端使用（首页 → 左侧「白板」→ 点击画布打开）；当前为浏览器预览，白板保存/读取不可用。
    </div>

    <!-- 标题栏（可拖拽移动窗口） -->
    <header class="toolbar">
      <div class="toolbar-groups" @mousedown="onDragDown" @dblclick="onDragDblClick">
        <div class="project-info" title="白板文件保存于全局白板目录（不随项目）">
          <span class="project-name">白板</span>
          <span class="scene-name mono">{{ store.fileName() }}<i v-if="store.state.dirty" class="sv-dirty-dot" /></span>
        </div>

        <!-- 白板尺寸：预设下拉 + 自定义宽高 -->
        <label v-if="!sizeCustomizing" class="sv-size-field" title="白板尺寸">
          <select :value="resolutionPreset" @change="onSizeSelect(($event.target as HTMLSelectElement).value)">
            <optgroup v-for="[g, items] in resolutionGroups" :key="g" :label="g">
              <option v-for="it in items" :key="it.label" :value="it.label">{{ it.label }}</option>
            </optgroup>
            <option value="__custom__">自定义…</option>
          </select>
        </label>
        <label v-else class="sv-size-field sv-size-custom" title="自定义白板尺寸">
          <input v-model.number="customW" type="number" min="1" max="8192" title="宽度" />
          <span>×</span>
          <input v-model.number="customH" type="number" min="1" max="8192" title="高度" />
          <button class="sv-size-apply" title="应用自定义尺寸" @click="applyCustomSize">✓</button>
          <button class="sv-size-cancel" title="取消" @click="sizeCustomizing = false">✕</button>
        </label>

        <div class="spacer"></div>

        <!-- 新文档：保存文件名（落全局白板目录） -->
        <label v-if="!store.state.currentFile && !store.state.degraded" class="sv-name-field" title="保存文件名（写入全局白板目录）">
          <input
            :value="store.state.saveName"
            spellcheck="false"
            @input="store.setSaveName(($event.target as HTMLInputElement).value)"
            @keydown.enter="($event.target as HTMLInputElement).blur()"
          />
          <span>.svg 自动补全 · 白板目录</span>
        </label>

        <button
          class="primary sv-save-btn"
          :title="store.state.degraded ? '浏览器预览无法保存白板' : '保存（Ctrl+S）'"
          @click="store.save()"
        >
          保存
          <span v-if="store.state.dirty" class="save-dirty-dot" aria-label="有未保存修改"></span>
        </button>
        <button :disabled="!store.canUndo()" title="撤销（Ctrl+Z）" @click="store.undo()">撤销</button>
        <button :disabled="!store.canRedo()" title="重做（Ctrl+Y）" @click="store.redo()">重做</button>

        <WindowControls />
      </div>
    </header>

      <!-- 主体：画布（底部悬浮工具条）+ 右侧面板 -->
      <div class="sv-main">
        <div class="sv-stage-wrap">
          <WhiteboardStage ref="stageRef" />

          <!-- 幻灯片浮动工具（画布左下角）：图层当页播放 -->
          <WhiteboardSlideBar />

          <!-- 浮动工具条：画布底部居中悬浮，SVG 图标按钮 -->
          <div class="sv-float-stack">
            <!-- 线条粗细滑动条（直线/铅笔/钢笔工具时显示） -->
            <div v-if="showWidthSlider" class="sv-width-pill">
              <span class="sv-width-label">粗细</span>
              <Slider
                class="sv-width-slider"
                :model-value="whiteboardLayout.toolWidth"
                :min="1"
                :max="24"
                :step="1"
                title="线条粗细"
                @update:model-value="setToolWidth"
              />
              <span class="sv-width-val">{{ whiteboardLayout.toolWidth }}px</span>
            </div>
            <div class="sv-float-bar" role="toolbar" title="工具">
            <button
              v-for="t in TOOLS"
              :key="t.key"
              class="sv-fb-btn"
              :class="{ active: store.state.tool === t.key }"
              :title="t.title"
              :aria-label="t.title"
              @click="store.setTool(t.key)"
            >
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                v-html="TOOL_ICONS[t.key]"
              ></svg>
            </button>
            <span class="sv-fb-sep"></span>
            <button class="sv-fb-btn" title="适应画板取景" aria-label="适应画板取景" @click="fitStage">
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                v-html="TOOL_ICONS.fit"
              ></svg>
            </button>
            </div>
          </div>
        </div>

        <!-- 浮动面板（图层/属性/动画）：悬浮于画布右上，拖动把手移动，可收起 -->
        <div class="sv-float-panel" :class="{ collapsed: whiteboardLayout.panelCollapsed }" :style="panelStyle">
          <div class="sv-fp-head">
            <span class="sv-fp-grip" title="拖动移动面板" @pointerdown="onPanelDragDown">
              <svg viewBox="0 0 10 16" width="10" height="14" fill="currentColor">
                <circle cx="2.5" cy="2.5" r="1.3" /><circle cx="7.5" cy="2.5" r="1.3" />
                <circle cx="2.5" cy="8" r="1.3" /><circle cx="7.5" cy="8" r="1.3" />
                <circle cx="2.5" cy="13.5" r="1.3" /><circle cx="7.5" cy="13.5" r="1.3" />
              </svg>
            </span>
            <div class="sv-side-tabs" role="tablist">
              <button
                v-for="t in (['layers', 'props'] as const)"
                :key="t"
                class="sv-side-tab"
                :class="{ active: whiteboardLayout.sideTab === t }"
                role="tab"
                :aria-selected="whiteboardLayout.sideTab === t"
                @click="setSideTab(t)"
              >
                {{ t === "layers" ? "图层" : "属性" }}
              </button>
            </div>
            <button
              class="sv-fp-collapse"
              :title="whiteboardLayout.panelCollapsed ? '展开面板' : '收起面板'"
              @click="togglePanelCollapsed()"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path v-if="whiteboardLayout.panelCollapsed" d="M6 15l6-6 6 6" />
                <path v-else d="M6 9l6 6 6-6" />
              </svg>
            </button>
          </div>
          <div v-show="!whiteboardLayout.panelCollapsed" class="sv-fp-body">
            <WhiteboardLayersPanel v-show="whiteboardLayout.sideTab === 'layers'" />
            <WhiteboardPropsPanel v-show="whiteboardLayout.sideTab === 'props'" />
          </div>
        </div>
      </div>

      <!-- 状态条（气泡提示走 ui-kit 全局宿主，不再占用状态条） -->
      <footer class="sv-status">
        <span class="sv-flex"></span>
        <span class="sv-status-hint">{{ toolHint }}</span>
        <span class="mono">
          {{ store.state.doc.els.length }} 元素 · {{ store.state.doc.layers.length }} 图层 ·
          {{ store.state.doc.w }}×{{ store.state.doc.h }}
        </span>
      </footer>

      <!-- ui-kit 上下文菜单宿主（幻灯片页码列表等浮层挂载点） -->
      <ContextMenu />
      <!-- 全局气泡通知（白板窗口独立挂载：提示统一走这里） -->
      <ToastHost />
  </div>
</template>
