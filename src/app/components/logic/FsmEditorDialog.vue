<script setup lang="ts">
/**
 * 状态机可视化编辑器（弹窗；.fsm 资产）：
 * - SVG 画布：状态卡片拖拽布局、过渡曲线（双向对错开）、滚轮缩放 /
 *   左键拖空白或中键任意处拖拽平移；右键为自定义菜单（弹窗内屏蔽浏览器默认菜单）；
 * - 双击空白新建状态；「连接到…」进入连线模式后点击目标状态建过渡；
 * - 右侧属性面板：状态（名称/颜色/入口）与过渡（事件/定时/参数条件）编辑，
 *   未选中时编辑图参数（条件用的黑板默认值）；
 * - 保存：改动防抖自动写盘 + Ctrl+S / 按钮手动保存，关闭前冲刷未保存改动。
 *   序列化经 parseFsmGraph 收敛（api.fsmWrite，格式所有权在后端）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { getProjectStore } from "../../stores/project";
import { logStore } from "../../stores/log";
import { api } from "../../../lib/api";
import { closeFsmEditor } from "../../composables/logic-editor";
import { useGraphCanvas } from "../../composables/graph-canvas";
import { isEditingText } from "../../commands/context";
import {
  closeContextMenu,
  ctxMenu,
  openContextMenu,
  type CtxMenuItem,
} from "../../../lib/editor/context-menu";
import "../../../styles/components/logic-editor.scss";
import {
  FSM_STATE_COLORS,
  cloneFsmGraph,
  nextFsmStateId,
  nextFsmStateName,
  nextFsmTransitionId,
  parseFsmGraph,
  type FsmConditionOp,
  type FsmGraph,
  type FsmState,
} from "../../../framework/fsm";

const props = defineProps<{ rel: string }>();

const projectStore = getProjectStore();

const CONDITION_OPS: FsmConditionOp[] = [">", "<", ">=", "<=", "==", "!="];

/** 状态卡片尺寸（画布逻辑坐标；状态坐标为卡片中心） */
const CARD_W = 132;
const CARD_H = 46;

const svgEl = ref<SVGSVGElement | null>(null);
const { view, transform, toGraph, resetView, bindWheel } = useGraphCanvas(svgEl);

const loading = ref(true);
const loadError = ref("");
const graph = ref<FsmGraph | null>(null);
const dirty = ref(false);
const saving = ref(false);

type Selection = { kind: "state"; id: string } | { kind: "transition"; id: string } | null;
const selection = ref<Selection>(null);
/** 连线模式（from 状态 id）：点击其它状态即建过渡 */
const linking = ref<string | null>(null);

/** 图参数编辑行（保存时重建 graph.params） */
interface ParamRow {
  name: string;
  type: "number" | "bool";
  value: number | boolean;
}
const paramList = ref<ParamRow[]>([]);

const title = computed(() => props.rel.split("/").pop() ?? props.rel);
const states = computed(() => graph.value?.states ?? []);
const transitions = computed(() => graph.value?.transitions ?? []);
const selState = computed(() =>
  selection.value?.kind === "state"
    ? states.value.find((s) => s.id === selection.value?.id) ?? null
    : null,
);
const selTransition = computed(() =>
  selection.value?.kind === "transition"
    ? transitions.value.find((t) => t.id === selection.value?.id) ?? null
    : null,
);
/** 选中过渡的目标候选（排除自身源状态；parse 不接受自环） */
const selToOptions = computed(() =>
  selTransition.value ? states.value.filter((s) => s.id !== selTransition.value?.from) : [],
);

// —— 装载 / 保存 ——

function paramsFromList(): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const r of paramList.value) {
    const name = r.name.trim();
    if (name) out[name] = r.type === "bool" ? !!r.value : Number(r.value) || 0;
  }
  return out;
}

async function load(): Promise<void> {
  const root = projectStore.currentPath;
  if (!root) return;
  try {
    const text = await api.readText(root, props.rel);
    const doc = JSON.parse(text) as { graph?: unknown };
    const g = parseFsmGraph(doc.graph);
    graph.value = cloneFsmGraph(g);
    paramList.value = Object.entries(g.params).map(([name, value]) => ({
      name,
      type: typeof value === "boolean" ? ("bool" as const) : ("number" as const),
      value,
    }));
  } catch (e) {
    loadError.value = String(e);
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  const root = projectStore.currentPath;
  if (!root || !graph.value || saving.value) return;
  saving.value = true;
  try {
    const name = title.value.replace(/\.fsm$/i, "");
    // 参数面板（paramList）是参数的唯一编辑入口：保存前重建 graph.params
    graph.value = { ...graph.value, params: paramsFromList() };
    await api.fsmWrite(root, props.rel, name, JSON.parse(JSON.stringify(graph.value)));
    dirty.value = false;
    logStore.log("success", `已保存状态机: ${props.rel}`);
  } catch (e) {
    logStore.log("error", `保存状态机失败: ${e}`);
  } finally {
    saving.value = false;
  }
}

let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
/** 改动标记 + 防抖自动保存 */
function markDirty(): void {
  dirty.value = true;
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => void save(), 800);
}

/** 关闭前冲刷未保存改动 */
async function requestClose(): Promise<void> {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  if (dirty.value && graph.value) await save();
  closeFsmEditor();
}

// —— 画布几何 ——

interface EdgeGeo {
  d: string;
  mx: number;
  my: number;
}

/** 状态边界上朝 (ux,uy) 方向的锚点（状态坐标为卡片中心） */
function borderPoint(s: FsmState, ux: number, uy: number): { x: number; y: number } {
  const t = Math.min(
    CARD_W / 2 / (Math.abs(ux) || 1e-9),
    CARD_H / 2 / (Math.abs(uy) || 1e-9),
  );
  return { x: s.x + ux * t, y: s.y + uy * t };
}

function edgeGeometry(a: FsmState, b: FsmState, hasReverse: boolean): EdgeGeo {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const p1 = borderPoint(a, ux, uy);
  const p2 = borderPoint(b, -ux, -uy);
  // 双向过渡对彼此错开（沿法线偏移控制点），单边走直线邻域
  const bend = hasReverse ? 34 : 0;
  const px = -uy * bend;
  const py = ux * bend;
  const k = Math.min(90, Math.max(24, len * 0.38));
  const c1x = p1.x + ux * k + px;
  const c1y = p1.y + uy * k + py;
  const c2x = p2.x - ux * k + px;
  const c2y = p2.y - uy * k + py;
  return {
    d: `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`,
    mx: 0.125 * p1.x + 0.375 * c1x + 0.375 * c2x + 0.125 * p2.x,
    my: 0.125 * p1.y + 0.375 * c1y + 0.375 * c2y + 0.125 * p2.y,
  };
}

/** 全部过渡的几何（含反向标记与标签） */
const edges = computed<(EdgeGeo & { id: string; label: string; selected: boolean })[]>(() => {
  const byId = new Map(states.value.map((s) => [s.id, s]));
  const pairs = new Set(transitions.value.map((t) => `${t.from}>${t.to}`));
  const out: (EdgeGeo & { id: string; label: string; selected: boolean })[] = [];
  for (const tr of transitions.value) {
    const a = byId.get(tr.from);
    const b = byId.get(tr.to);
    if (!a || !b) continue;
    out.push({
      id: tr.id,
      label: transitionLabel(tr),
      selected: selection.value?.kind === "transition" && selection.value.id === tr.id,
      ...edgeGeometry(a, b, pairs.has(`${tr.to}>${tr.from}`)),
    });
  }
  return out;
});

function transitionLabel(tr: { event: string; duration: number; conditions: unknown[] }): string {
  const parts: string[] = [];
  if (tr.event) parts.push(tr.event);
  if (tr.duration > 0) parts.push(`${tr.duration}s`);
  if (tr.conditions.length) parts.push(`${tr.conditions.length} 条件`);
  return parts.join(" · ");
}

// —— 画布交互（平移 / 状态拖拽 / 双击新建） ——

type Interaction =
  | {
      kind: "pan";
      startClientX: number;
      startClientY: number;
      startViewX: number;
      startViewY: number;
    }
  | {
      kind: "state";
      id: string;
      startGraphX: number;
      startGraphY: number;
      origX: number;
      origY: number;
    }
  | null;
let interaction: Interaction = null;

function isBgTarget(e: Event): boolean {
  const t = e.target as HTMLElement | SVGElement | null;
  return !t || t === svgEl.value || t.dataset?.bg === "1";
}

/** 从指针按下处开始平移（move 中按起点绝对定位 view，避免增量累加漂移） */
function startPan(e: PointerEvent): void {
  interaction = {
    kind: "pan",
    startClientX: e.clientX,
    startClientY: e.clientY,
    startViewX: view.x,
    startViewY: view.y,
  };
}

function onSvgPointerDown(e: PointerEvent): void {
  // 中键：任意位置（含卡片/连线上）拖拽平移；preventDefault 阻止自动滚动
  if (e.button === 1) {
    e.preventDefault();
    startPan(e);
    return;
  }
  if (e.button !== 0) return;
  if (!isBgTarget(e)) return;
  // 空白左键按下：退出连线、清除选中，进入平移
  if (linking.value) linking.value = null;
  else selection.value = null;
  startPan(e);
}

function onStatePointerDown(e: PointerEvent, s: FsmState): void {
  if (e.button === 1) {
    e.preventDefault();
    startPan(e);
    return;
  }
  if (e.button !== 0) return;
  // 连线模式：点击其它状态 → 建过渡；点击自身 → 取消
  if (linking.value) {
    const from = linking.value;
    linking.value = null;
    if (s.id !== from) addTransition(from, s.id);
    return;
  }
  selection.value = { kind: "state", id: s.id };
  const g = toGraph(e.clientX, e.clientY);
  interaction = { kind: "state", id: s.id, startGraphX: g.x, startGraphY: g.y, origX: s.x, origY: s.y };
}

function onPointerMove(e: PointerEvent): void {
  const it = interaction;
  if (!it) return;
  if (it.kind === "pan") {
    // 绝对定位：起点视图 + 指针相对起点的位移（不可用 panBy 累加，否则漂移）
    view.x = it.startViewX + (e.clientX - it.startClientX);
    view.y = it.startViewY + (e.clientY - it.startClientY);
    return;
  }
  const s = states.value.find((x) => x.id === it.id);
  if (!s) return;
  const g = toGraph(e.clientX, e.clientY);
  s.x = Math.round(it.origX + (g.x - it.startGraphX));
  s.y = Math.round(it.origY + (g.y - it.startGraphY));
}

function onPointerUp(): void {
  interaction = null;
}

/** 双击空白：在指针位置新建状态 */
function onSvgDblClick(e: MouseEvent): void {
  if (!isBgTarget(e) || !graph.value) return;
  addStateAt(toGraph(e.clientX, e.clientY));
}

// —— 右键菜单（屏蔽浏览器默认菜单，按目标给出编辑动作） ——

function onBgContext(e: MouseEvent): void {
  if (!graph.value) return;
  const pos = toGraph(e.clientX, e.clientY);
  openContextMenu(e, [
    { label: "新建状态", onClick: () => addStateAt(pos) },
    { separator: true },
    { label: "重置视图", onClick: resetView },
  ]);
}

function onStateContext(e: MouseEvent, s: FsmState): void {
  if (!graph.value) return;
  selection.value = { kind: "state", id: s.id };
  const items: CtxMenuItem[] = [
    { label: "连接到…", disabled: linking.value === s.id, onClick: () => toggleLinking() },
    { label: "设为入口", disabled: s.id === graph.value?.entry, onClick: setEntry },
    { separator: true },
    { label: "删除状态", danger: true, shortcut: "Del", onClick: deleteSelection },
  ];
  openContextMenu(e, items);
}

function onEdgeContext(e: MouseEvent, id: string): void {
  selection.value = { kind: "transition", id };
  openContextMenu(e, [
    { label: "删除过渡", danger: true, shortcut: "Del", onClick: deleteSelection },
  ]);
}

// —— 编辑动作 ——

function addStateAt(pos: { x: number; y: number }): void {
  if (!graph.value) return;
  const state: FsmState = {
    id: nextFsmStateId(graph.value),
    name: nextFsmStateName(graph.value),
    x: Math.round(pos.x),
    y: Math.round(pos.y),
    color: FSM_STATE_COLORS[graph.value.states.length % FSM_STATE_COLORS.length],
  };
  graph.value.states.push(state);
  if (graph.value.states.length === 1) graph.value.entry = state.id;
  selection.value = { kind: "state", id: state.id };
  markDirty();
}

function addStateCentered(): void {
  const rect = svgEl.value?.getBoundingClientRect();
  const pos = rect
    ? toGraph(rect.left + rect.width / 2, rect.top + rect.height / 2)
    : { x: 120, y: 120 };
  addStateAt(pos);
}

function addTransition(from: string, to: string): void {
  if (!graph.value || from === to) return;
  if (graph.value.transitions.some((t) => t.from === from && t.to === to)) {
    logStore.log("warn", "两个状态之间已存在过渡（选中后编辑触发器即可）");
    return;
  }
  const tr = {
    id: nextFsmTransitionId(graph.value),
    from,
    to,
    event: "",
    duration: 0,
    conditions: [] as { param: string; op: FsmConditionOp; value: number }[],
  };
  graph.value.transitions.push(tr);
  selection.value = { kind: "transition", id: tr.id };
  markDirty();
}

function toggleLinking(): void {
  if (!selState.value) return;
  linking.value = linking.value ? null : selState.value.id;
  if (linking.value) logStore.log("info", "连线模式：点击目标状态创建过渡（Esc 取消）");
}

function setEntry(): void {
  if (!graph.value || !selState.value) return;
  graph.value.entry = selState.value.id;
  markDirty();
}

function deleteSelection(): void {
  const sel = selection.value;
  if (!sel || !graph.value) return;
  if (sel.kind === "state") {
    graph.value.states = graph.value.states.filter((s) => s.id !== sel.id);
    graph.value.transitions = graph.value.transitions.filter(
      (t) => t.from !== sel.id && t.to !== sel.id,
    );
    if (graph.value.entry === sel.id) graph.value.entry = graph.value.states[0]?.id ?? "";
  } else {
    graph.value.transitions = graph.value.transitions.filter((t) => t.id !== sel.id);
  }
  selection.value = null;
  markDirty();
}

// —— 参数与条件编辑 ——

function addParam(): void {
  let i = paramList.value.length + 1;
  const used = new Set(paramList.value.map((p) => p.name));
  while (used.has(`param${i}`)) i++;
  paramList.value.push({ name: `param${i}`, type: "number", value: 0 });
  markDirty();
}

function removeParam(i: number): void {
  paramList.value.splice(i, 1);
  markDirty();
}

function addCondition(): void {
  const tr = selTransition.value;
  if (!tr || !graph.value) return;
  tr.conditions.push({ param: "", op: ">=", value: 0 });
  markDirty();
}

function removeCondition(i: number): void {
  selTransition.value?.conditions.splice(i, 1);
  markDirty();
}

// —— 键盘 ——

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    if (ctxMenu.open) {
      closeContextMenu();
      return;
    }
    if (linking.value) linking.value = null;
    else void requestClose();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    e.stopPropagation();
    void save();
    return;
  }
  if ((e.key === "Delete" || e.key === "Backspace") && !isEditingText()) {
    e.preventDefault();
    deleteSelection();
  }
}

// —— 生命周期 ——

let unbindWheel: (() => void) | null = null;

onMounted(async () => {
  window.addEventListener("keydown", onKeydown, true);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  await load();
  // svg 在 loading 结束后才渲染，等一帧再绑 wheel，避免绑到空引用
  await nextTick();
  unbindWheel = bindWheel();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown, true);
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  if (unbindWheel) unbindWheel();
});
</script>

<template>
  <Teleport to="body">
    <div class="logic-modal-backdrop" @contextmenu.prevent>
      <div class="logic-modal">
        <div class="logic-modal-head">
          <span class="logic-modal-title">状态机编辑器 · {{ title }}</span>
          <span v-if="dirty" class="logic-modal-dirty">未保存</span>
          <span class="logic-modal-rel mono">{{ rel }}</span>
          <button
            class="logic-modal-btn primary"
            :disabled="saving || !dirty"
            :title="dirty ? '保存（Ctrl+S）' : '无改动'"
            @click="save"
          >
            {{ saving ? "保存中…" : "保存" }}
          </button>
          <button class="logic-modal-close" title="关闭（Esc）" @click="requestClose">✕</button>
        </div>

        <div class="logic-toolbar">
          <button class="logic-modal-btn" @click="addStateCentered">＋ 状态</button>
          <button
            class="logic-modal-btn"
            :class="{ active: !!linking }"
            :disabled="!selState"
            title="选中源状态后点击，再点击目标状态创建过渡"
            @click="toggleLinking"
          >
            连接到…
          </button>
          <button class="logic-modal-btn" :disabled="!selState || selState.id === graph?.entry" @click="setEntry">
            设为入口
          </button>
          <div class="logic-tool-sep"></div>
          <button class="logic-modal-btn danger" :disabled="!selection" @click="deleteSelection">
            删除选中
          </button>
          <div class="logic-tool-sep"></div>
          <button class="logic-modal-btn" title="重置平移与缩放" @click="resetView">重置视图</button>
          <span class="logic-tool-hint">双击空白新建状态 · 左键拖空白 / 中键拖拽平移 · 滚轮缩放 · 右键菜单 · Del 删除</span>
        </div>

        <div class="logic-modal-body">
          <div v-if="loading" class="logic-empty">读取中…</div>
          <div v-else-if="!graph" class="logic-empty">读取失败：{{ loadError }}</div>
          <template v-else>
            <div class="logic-canvas-wrap">
              <svg
                ref="svgEl"
                class="logic-canvas"
                @pointerdown="onSvgPointerDown"
                @dblclick="onSvgDblClick"
                @contextmenu.prevent="onBgContext"
              >
                <defs>
                  <pattern
                    id="fsm-grid"
                    width="24"
                    height="24"
                    patternUnits="userSpaceOnUse"
                    :patternTransform="`translate(${view.x},${view.y}) scale(${view.k})`"
                  >
                    <circle cx="1" cy="1" r="1" fill="#2c2c2c" />
                  </pattern>
                  <marker
                    id="fsm-arrow"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path d="M0 0L10 5L0 10z" fill="#8a8a8a" />
                  </marker>
                  <marker
                    id="fsm-arrow-sel"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path d="M0 0L10 5L0 10z" fill="#58a6ff" />
                  </marker>
                </defs>
                <rect width="100%" height="100%" fill="url(#fsm-grid)" data-bg="1" />
                <g :transform="transform">
                  <g v-for="e in edges" :key="e.id">
                    <path
                      class="logic-edge-hit"
                      :d="e.d"
                      @pointerdown.stop="selection = { kind: 'transition', id: e.id }"
                      @contextmenu.prevent.stop="onEdgeContext($event, e.id)"
                    />
                    <path
                      class="logic-edge"
                      :class="{ selected: e.selected }"
                      :d="e.d"
                      :marker-end="e.selected ? 'url(#fsm-arrow-sel)' : 'url(#fsm-arrow)'"
                    />
                    <text v-if="e.label" class="logic-edge-label" :x="e.mx" :y="e.my">{{ e.label }}</text>
                  </g>
                  <g
                    v-for="s in graph.states"
                    :key="s.id"
                    class="logic-state-card"
                    :class="{ selected: selection?.kind === 'state' && selection.id === s.id }"
                    :transform="`translate(${s.x},${s.y})`"
                    @pointerdown.stop="onStatePointerDown($event, s)"
                    @contextmenu.prevent.stop="onStateContext($event, s)"
                  >
                    <rect
                      class="logic-state-box"
                      :class="{ entry: s.id === graph.entry }"
                      :x="-CARD_W / 2"
                      :y="-CARD_H / 2"
                      :width="CARD_W"
                      :height="CARD_H"
                      rx="10"
                      :stroke="s.color"
                    />
                    <text text-anchor="middle" dominant-baseline="middle" y="1">{{ s.name }}</text>
                    <text
                      v-if="s.id === graph.entry"
                      class="logic-state-entry"
                      text-anchor="middle"
                      :y="-CARD_H / 2 - 8"
                    >
                      ▶ 入口
                    </text>
                  </g>
                </g>
              </svg>
            </div>

            <div class="logic-props">
              <!-- 状态属性 -->
              <template v-if="selState">
                <div class="logic-props-section">
                  <span class="logic-props-title">
                    状态
                    <span v-if="selState.id === graph?.entry" class="logic-badge">入口</span>
                  </span>
                  <div class="logic-field">
                    <label>名称</label>
                    <input v-model="selState.name" class="logic-input" @change="markDirty" />
                  </div>
                  <div class="logic-field">
                    <label>颜色</label>
                    <select v-model="selState.color" class="logic-input" @change="markDirty">
                      <option v-for="c in FSM_STATE_COLORS" :key="c" :value="c">{{ c }}</option>
                    </select>
                  </div>
                </div>
                <div class="logic-props-section">
                  <span class="logic-hint">
                    出向过渡 {{ transitions.filter((t) => t.from === selState?.id).length }} 条 ·
                    入向过渡 {{ transitions.filter((t) => t.to === selState?.id).length }} 条
                  </span>
                </div>
              </template>

              <!-- 过渡属性 -->
              <template v-else-if="selTransition">
                <div class="logic-props-section">
                  <span class="logic-props-title">过渡</span>
                  <div class="logic-field">
                    <label>源状态</label>
                    <select v-model="selTransition.from" class="logic-input" @change="markDirty">
                      <option v-for="s in graph?.states" :key="s.id" :value="s.id">{{ s.name }}</option>
                    </select>
                  </div>
                  <div class="logic-field">
                    <label>目标状态</label>
                    <select v-model="selTransition.to" class="logic-input" @change="markDirty">
                      <option v-for="s in selToOptions" :key="s.id" :value="s.id">{{ s.name }}</option>
                    </select>
                  </div>
                </div>
                <div class="logic-props-section">
                  <span class="logic-props-title">触发器（全部满足才过渡）</span>
                  <div class="logic-field">
                    <label>事件</label>
                    <input
                      v-model="selTransition.event"
                      class="logic-input mono"
                      placeholder="空 = 不依赖事件"
                      @change="markDirty"
                    />
                  </div>
                  <div class="logic-field">
                    <label>定时秒数</label>
                    <input
                      v-model.number="selTransition.duration"
                      type="number"
                      min="0"
                      step="0.1"
                      class="logic-input"
                      @change="markDirty"
                    />
                  </div>
                  <div v-for="(c, i) in selTransition.conditions" :key="i" class="logic-cond-row">
                    <input v-model="c.param" class="logic-input" placeholder="参数名" @change="markDirty" />
                    <select v-model="c.op" class="logic-input" @change="markDirty">
                      <option v-for="op in CONDITION_OPS" :key="op" :value="op">{{ op }}</option>
                    </select>
                    <input v-model.number="c.value" type="number" step="0.1" class="logic-input" @change="markDirty" />
                    <button class="logic-icon-btn" title="删除条件" @click="removeCondition(i)">×</button>
                  </div>
                  <button class="logic-modal-btn" @click="addCondition">＋ 条件</button>
                </div>
              </template>

              <!-- 未选中：图参数（黑板默认值） -->
              <template v-else>
                <div class="logic-props-section">
                  <span class="logic-props-title">图参数（条件黑板默认值）</span>
                  <div v-for="(p, i) in paramList" :key="i" class="logic-param-row">
                    <input v-model="p.name" class="logic-input mono" @change="markDirty" />
                    <select v-model="p.type" class="logic-input" @change="markDirty">
                      <option value="number">数值</option>
                      <option value="bool">布尔</option>
                    </select>
                    <input
                      v-if="p.type === 'number'"
                      v-model.number="p.value"
                      type="number"
                      step="0.1"
                      class="logic-input"
                      @change="markDirty"
                    />
                    <select v-else v-model="p.value" class="logic-input" @change="markDirty">
                      <option :value="true">真</option>
                      <option :value="false">假</option>
                    </select>
                    <button class="logic-icon-btn" title="删除参数" @click="removeParam(i)">×</button>
                  </div>
                  <button class="logic-modal-btn" @click="addParam">＋ 参数</button>
                </div>
                <div class="logic-props-section">
                  <div class="logic-stat"><span>状态数</span><span class="mono">{{ graph.states.length }}</span></div>
                  <div class="logic-stat"><span>过渡数</span><span class="mono">{{ graph.transitions.length }}</span></div>
                </div>
                <div class="logic-props-section">
                  <span class="logic-hint">
                    过渡触发：事件（运行时 fire）、在源状态停留达到定时秒数、参数条件全部成立——
                    声明的触发器都满足才切换；全不声明则进入源状态后立即过渡。
                    未选中任何元素时编辑图参数；选中状态/过渡编辑其属性。
                  </span>
                </div>
              </template>
            </div>
          </template>
        </div>

        <div class="logic-modal-foot">
          状态机资产（.fsm）：状态卡可拖拽布置；「连接到…」后点击目标状态建过渡。
          过渡按出边顺序检查，首个触发器全部满足的出边生效；条件引用图参数（运行时可写）。
        </div>
      </div>
    </div>
  </Teleport>
</template>
