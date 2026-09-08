<script setup lang="ts">
// ---------------------------------------------------------------------------
// 动画编辑窗口（底部停靠面板，Unity Animation 窗口的轻量版）：
// - 编辑 .anim 剪辑资产（时长/循环/关键帧），改动防抖自动写盘；
// - 时间轴：标尺 + 播放头拖拽 scrub + 9 个变换通道关键帧轨道（拖拽改时间、
//   点击选中、插值切换、删除）；K 按钮在当前时间 K 选中节点当前值；
// - 录制模式：开启后轮询选中节点的变换数据，变化即自动写入关键帧（auto-key）；
// - 预览：播放/scrub 把采样值直接应用到选中节点的三维对象（不写节点数据，
//   非破坏性，停止后还原）；曲线视图：单通道曲线 + 关键帧拖拽/空白点击插帧。
// ---------------------------------------------------------------------------
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as THREE from "three";
import type { Node } from "../../framework/prototype/Node";
import {
  PROP_CHANNELS,
  evaluateClip,
  evaluateCurve,
  parseAnimationClip,
  removeKeyAt,
  upsertKey,
  type AnimClipCurve,
  type AnimKeyInterp,
  type AnimationClipData,
  type TransformProp,
} from "../../framework/animation/clip";
import { getEditorStore } from "../stores/editor";
import { getProjectStore } from "../stores/project";
import { getAssetsStore } from "../stores/assets";
import { api } from "../../lib/api";
import { animEditor } from "../lib/anim-editor";
import NumberField from "./NumberField.vue";

const editorStore = getEditorStore();
const projectStore = getProjectStore();
const assetsStore = getAssetsStore();
const { engine } = editorStore;

const D2R = Math.PI / 180;

// ---------------------------------------------------------------------------
// 剪辑加载 / 保存（改动防抖自动写盘）
// ---------------------------------------------------------------------------
const clipRel = ref("");
const doc = ref<AnimationClipData | null>(null);
const rev = ref(0);
const dirty = ref(false);
const saving = ref(false);
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let loadToken = 0;

function touch(): void {
  rev.value += 1;
  dirty.value = true;
  scheduleSave();
}

function flushSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    void saveNow();
  }
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveNow(), 600);
}

async function saveNow(): Promise<void> {
  const root = projectStore.currentPath;
  if (!root || !doc.value || !clipRel.value) return;
  saving.value = true;
  try {
    await api.writeText(root, clipRel.value, JSON.stringify(doc.value, null, 2));
    dirty.value = false;
  } catch (e) {
    console.error("保存动画剪辑失败", e);
  } finally {
    saving.value = false;
  }
}

async function loadClip(rel: string): Promise<void> {
  const token = ++loadToken;
  stopPreview();
  flushSave();
  clipRel.value = rel;
  doc.value = null;
  dirty.value = false;
  time.value = 0;
  selected.value = null;
  if (!rel) {
    rev.value += 1;
    return;
  }
  const root = projectStore.currentPath;
  if (!root) {
    rev.value += 1;
    return;
  }
  try {
    const text = await api.readText(root, rel);
    if (token !== loadToken) return;
    doc.value = parseAnimationClip(JSON.parse(text));
  } catch (e) {
    console.error("加载动画剪辑失败", e);
    doc.value = null;
  }
  rev.value += 1;
}

// 外部打开请求（资产检查器/组件卡「在动画编辑器中打开」）
watch(
  () => animEditor.seq,
  () => {
    if (animEditor.clipRel && animEditor.clipRel !== clipRel.value) {
      void loadClip(animEditor.clipRel);
    }
  },
);

const clipOptions = computed(() =>
  assetsStore.assets.filter((a) => a.kind === "anim" && !a.path.startsWith("internal/")),
);

function onPickClip(e: Event): void {
  void loadClip((e.target as HTMLSelectElement).value);
}

// ---------------------------------------------------------------------------
// 目标节点（场景选中）与预览应用（非破坏：只动三维对象，停止还原）
// ---------------------------------------------------------------------------
const targetNode = computed<Node | null>(() => {
  const id = editorStore.state.selectedId;
  return id ? (engine.graph.get(id) ?? null) : null;
});

const targetObj = computed<THREE.Object3D | null>(() => {
  const n = targetNode.value;
  return n ? (engine.synchronizer.getObjectMap().get(n.id) ?? null) : null;
});

function applyChannels(obj: THREE.Object3D, values: Map<TransformProp, number>): void {
  for (const [prop, v] of values) {
    const dot = prop.indexOf(".");
    const group = prop.slice(0, dot);
    const axis = prop.slice(dot + 1) as "x" | "y" | "z";
    if (group === "position") obj.position[axis] = v;
    else if (group === "rotation") obj.rotation[axis] = v * D2R;
    else if (group === "scale") obj.scale[axis] = Math.max(0.001, v);
  }
}

let appliedNodeId: string | null = null;
let savedPose: { p: THREE.Vector3; r: THREE.Euler; s: THREE.Vector3 } | null = null;

function beginApply(obj: THREE.Object3D, node: Node): void {
  if (appliedNodeId !== node.id) {
    restorePreview();
    appliedNodeId = node.id;
    savedPose = { p: obj.position.clone(), r: obj.rotation.clone(), s: obj.scale.clone() };
  }
}

function restorePreview(): void {
  const obj = appliedNodeId ? engine.synchronizer.getObjectMap().get(appliedNodeId) : null;
  if (obj && savedPose) {
    obj.position.copy(savedPose.p);
    obj.rotation.copy(savedPose.r);
    obj.scale.copy(savedPose.s);
  }
  appliedNodeId = null;
  savedPose = null;
}

function previewAt(t: number): void {
  const d = doc.value;
  const obj = targetObj.value;
  const node = targetNode.value;
  if (!d || !obj || !node) return;
  beginApply(obj, node);
  applyChannels(obj, evaluateClip(d, t));
}

// ---------------------------------------------------------------------------
// 播放 / 录制（单 rAF 驱动：播放推进 + 录制 auto-key 捕获）
// ---------------------------------------------------------------------------
const time = ref(0);
const playing = ref(false);
const recording = ref(false);
let raf = 0;
let lastTs = 0;
let captured = new Map<TransformProp, number>();

function currentValues(node: Node): Map<TransformProp, number> {
  const t = node.transform;
  return new Map<TransformProp, number>([
    ["position.x", t.position.x],
    ["position.y", t.position.y],
    ["position.z", t.position.z],
    ["rotation.x", t.rotation.x],
    ["rotation.y", t.rotation.y],
    ["rotation.z", t.rotation.z],
    ["scale.x", t.scale.x],
    ["scale.y", t.scale.y],
    ["scale.z", t.scale.z],
  ]);
}

function frame(ts: number): void {
  raf = requestAnimationFrame(frame);
  const dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 0;
  lastTs = ts;
  const d = doc.value;
  if (!d) return;
  if (playing.value) {
    time.value += dt;
    if (d.loops) time.value %= d.duration;
    else if (time.value >= d.duration) {
      time.value = d.duration;
      playing.value = false;
      stopPreview();
    }
    previewAt(time.value);
  }
  if (recording.value) captureFromNode(targetNode.value);
}

function captureFromNode(node: Node | null): void {
  const d = doc.value;
  if (!d || !node) return;
  for (const [prop, v] of currentValues(node)) {
    if (captured.has(prop) && Math.abs((captured.get(prop) as number) - v) < 1e-4) continue;
    upsertKey(curveOf(d, prop), time.value, v);
    captured.set(prop, v);
    touch();
  }
}

function beginCaptureBaseline(): void {
  captured = targetNode.value ? currentValues(targetNode.value) : new Map();
}

function togglePlaying(): void {
  playing.value = !playing.value;
  if (playing.value) {
    if (time.value >= (doc.value?.duration ?? 0)) time.value = 0;
    recording.value = false;
  } else {
    restorePreview();
  }
  lastTs = 0;
}

function stopPreview(): void {
  playing.value = false;
  recording.value = false;
  restorePreview();
  time.value = 0;
}

function toggleRecording(): void {
  if (!doc.value) return;
  recording.value = !recording.value;
  playing.value = false;
  restorePreview();
  if (recording.value) beginCaptureBaseline();
}

onMounted(() => {
  raf = requestAnimationFrame(frame);
  if (animEditor.clipRel && animEditor.clipRel !== clipRel.value) {
    void loadClip(animEditor.clipRel);
  }
});
onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  restorePreview();
});

// ---------------------------------------------------------------------------
// 剪辑属性与关键帧操作
// ---------------------------------------------------------------------------
function curveOf(d: AnimationClipData, prop: TransformProp): AnimClipCurve {
  let c = d.curves.find((x) => x.prop === prop);
  if (!c) {
    c = { prop, keys: [] };
    d.curves.push(c);
  }
  return c;
}

function onDurationChange(v: number): void {
  const d = doc.value;
  if (!d) return;
  d.duration = Math.max(0.1, v);
  time.value = Math.min(time.value, d.duration);
  touch();
}

function onLoopsChange(e: Event): void {
  const d = doc.value;
  if (!d) return;
  d.loops = (e.target as HTMLInputElement).checked;
  touch();
}

function keyChannel(prop: TransformProp): void {
  const d = doc.value;
  const node = targetNode.value;
  if (!d || !node) return;
  const v = currentValues(node).get(prop) as number;
  upsertKey(curveOf(d, prop), time.value, v);
  touch();
}

function keyAll(): void {
  const d = doc.value;
  const node = targetNode.value;
  if (!d || !node) return;
  for (const [prop, v] of currentValues(node)) {
    upsertKey(curveOf(d, prop), time.value, v);
  }
  touch();
}

function keysOf(prop: TransformProp): { t: number; v: number; i: AnimKeyInterp }[] {
  void rev.value;
  return doc.value?.curves.find((c) => c.prop === prop)?.keys ?? [];
}

function keyCount(prop: TransformProp): number {
  void rev.value;
  return doc.value?.curves.find((c) => c.prop === prop)?.keys.length ?? 0;
}

const selected = ref<{ prop: TransformProp; t: number } | null>(null);

function pickKey(prop: TransformProp, t: number): void {
  selected.value = { prop, t };
}

function deleteSelected(): void {
  const d = doc.value;
  const sel = selected.value;
  if (!d || !sel) return;
  const curve = d.curves.find((c) => c.prop === sel.prop);
  if (curve && removeKeyAt(curve, sel.t)) {
    selected.value = null;
    touch();
  }
}

function cycleInterp(): void {
  const d = doc.value;
  const sel = selected.value;
  if (!d || !sel) return;
  const k = d.curves
    .find((c) => c.prop === sel.prop)
    ?.keys.find((kk) => Math.abs(kk.t - sel.t) <= 1e-4);
  if (!k) return;
  const order: AnimKeyInterp[] = ["linear", "step", "smooth"];
  k.i = order[(order.indexOf(k.i) + 1) % order.length];
  touch();
}

const interpLabel = computed<string>(() => {
  void rev.value;
  const d = doc.value;
  const sel = selected.value;
  if (!d || !sel) return "";
  const k = d.curves
    .find((c) => c.prop === sel.prop)
    ?.keys.find((kk) => Math.abs(kk.t - sel.t) <= 1e-4);
  return k ? { linear: "线性", step: "阶跃", smooth: "平滑" }[k.i] : "";
});

// ---------------------------------------------------------------------------
// 时间轴几何与指针交互（标尺 scrub + 轨道关键帧拖拽共用换算）
// ---------------------------------------------------------------------------
const laneEl = ref<HTMLElement | null>(null);
const laneWidth = ref(600);
let laneRo: ResizeObserver | null = null;

onMounted(() => {
  laneRo = new ResizeObserver(() => {
    if (laneEl.value) laneWidth.value = laneEl.value.clientWidth;
  });
  if (laneEl.value) laneRo.observe(laneEl.value);
});
onBeforeUnmount(() => laneRo?.disconnect());

function tToX(t: number, duration: number): number {
  return (t / Math.max(0.1, duration)) * laneWidth.value;
}
function xToT(x: number, duration: number): number {
  return Math.max(0, Math.min(duration, (x / Math.max(1, laneWidth.value)) * duration));
}

const rulerTicks = computed<number[]>(() => {
  const d = doc.value?.duration ?? 3;
  const rawStep = d / 8;
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60];
  const step = steps.find((s) => s >= rawStep) ?? 60;
  const out: number[] = [];
  for (let t = 0; t <= d + 1e-6; t += step) out.push(t);
  return out;
});

type Drag =
  | { kind: "scrub" }
  | { kind: "key"; prop: TransformProp; index: number }
  | null;
let drag: Drag = null;
let laneLeftCache = 0;

function beginScrub(e: PointerEvent): void {
  const rect = laneEl.value?.getBoundingClientRect();
  if (!rect) return;
  laneLeftCache = rect.left;
  drag = { kind: "scrub" };
  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  time.value = xToT(e.clientX - rect.left, doc.value?.duration ?? 1);
  previewAt(time.value);
}

function beginKeyDrag(e: PointerEvent, prop: TransformProp, index: number): void {
  const rect = laneEl.value?.getBoundingClientRect();
  if (!rect) return;
  laneLeftCache = rect.left;
  drag = { kind: "key", prop, index };
  pickKey(prop, keysOf(prop)[index]?.t ?? 0);
  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
}

function onRulerPointerMove(e: PointerEvent): void {
  if (!drag || drag.kind !== "scrub") return;
  const d = doc.value;
  if (!d) return;
  time.value = xToT(e.clientX - laneLeftCache, d.duration);
  previewAt(time.value);
}

function onLanePointerMove(e: PointerEvent): void {
  if (!drag || drag.kind === "scrub") return;
  const d = doc.value;
  if (!d) return;
  // 捕获到局部量：drag 为模块级可变量，函数调用后 TS 收窄失效
  const dragProp: TransformProp = drag.prop;
  let dragIndex: number = drag.index;
  const curve = d.curves.find((c) => c.prop === dragProp);
  const key = curve?.keys[dragIndex];
  if (!key || !curve) return;
  key.t = xToT(e.clientX - laneLeftCache, d.duration);
  curve.keys.sort((a, b) => a.t - b.t);
  dragIndex = curve.keys.indexOf(key);
  selected.value = { prop: dragProp, t: key.t };
  touch();
}

function onLanePointerUp(): void {
  drag = null;
}

// ---------------------------------------------------------------------------
// 曲线视图（选中通道）：SVG 曲线 + 关键帧拖拽 + 空白点击插帧
// ---------------------------------------------------------------------------
const curveProp = ref<TransformProp>("position.y");
const curveSvgEl = ref<SVGSVGElement | null>(null);

const curveGeom = computed(() => {
  void rev.value;
  const d = doc.value;
  const curve = d?.curves.find((c) => c.prop === curveProp.value) ?? null;
  const keys = curve?.keys ?? [];
  const w = Math.max(320, laneWidth.value);
  const h = 150;
  const pad = 16;
  let lo = 0;
  let hi = 0;
  if (keys.length) {
    lo = Math.min(...keys.map((k) => k.v));
    hi = Math.max(...keys.map((k) => k.v));
  }
  if (hi - lo < 1e-6) {
    lo -= 1;
    hi += 1;
  } else {
    const padV = (hi - lo) * 0.15;
    lo -= padV;
    hi += padV;
  }
  const xOf = (t: number) => (d ? (t / Math.max(0.1, d.duration)) * (w - pad * 2) + pad : pad);
  const yOf = (v: number) => h - pad - ((v - lo) / (hi - lo)) * (h - pad * 2);
  const polyline: string[] = [];
  if (keys.length && d) {
    const N = 120;
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * d.duration;
      const v = evaluateCurve(curve as AnimClipCurve, t);
      if (v !== null) polyline.push(`${xOf(t).toFixed(1)},${yOf(v).toFixed(1)}`);
    }
  }
  return { w, h, pad, lo, hi, xOf, yOf, keys, polyline: polyline.join(" ") };
});

type CurveDrag = { index: number } | null;
let curveDrag: CurveDrag = null;

function onCurveDown(e: PointerEvent): void {
  const d = doc.value;
  const svg = curveSvgEl.value;
  if (!d || !svg) return;
  const r = svg.getBoundingClientRect();
  const g = curveGeom.value;
  const localX = e.clientX - r.left;
  const hit = g.keys.find((k) => Math.abs(g.xOf(k.t) - localX) < 6);
  if (hit) {
    pickKey(curveProp.value, hit.t);
    curveDrag = { index: g.keys.indexOf(hit) };
  } else {
    const t = xToT(localX, d.duration);
    const svgY = e.clientY - r.top;
    const v = g.lo + ((g.h - g.pad - svgY) / Math.max(1, g.h - g.pad * 2)) * (g.hi - g.lo);
    const curve = curveOf(d, curveProp.value);
    upsertKey(curve, t, v);
    pickKey(curveProp.value, t);
    curveDrag = { index: curve.keys.findIndex((k) => Math.abs(k.t - t) <= 1e-4) };
    touch();
  }
  svg.setPointerCapture?.(e.pointerId);
}

function onCurveMove(e: PointerEvent): void {
  const d = doc.value;
  if (curveDrag === null || !d || !curveSvgEl.value) return;
  const curve = d.curves.find((c) => c.prop === curveProp.value);
  const key = curve?.keys[curveDrag.index];
  if (!curve || !key) return;
  const r = curveSvgEl.value.getBoundingClientRect();
  const g = curveGeom.value;
  key.t = xToT(e.clientX - r.left, d.duration);
  const svgY = e.clientY - r.top;
  key.v = g.lo + ((g.h - g.pad - svgY) / Math.max(1, g.h - g.pad * 2)) * (g.hi - g.lo);
  curve.keys.sort((a, b) => a.t - b.t);
  curveDrag.index = curve.keys.indexOf(key);
  selected.value = { prop: curveProp.value, t: key.t };
  touch();
}

function onCurveUp(): void {
  curveDrag = null;
}
</script>

<template>
  <div class="panel anim-editor mono">
    <!-- 顶部工具条：剪辑选择 + 属性 + 播放/录制控制 -->
    <div class="anim-toolbar">
      <select class="anim-pick" :value="clipRel" title="选择要编辑的动画剪辑" @change="onPickClip($event)">
        <option value="">（选择动画剪辑 .anim）</option>
        <option v-for="a in clipOptions" :key="a.path" :value="a.path">{{ a.path }}</option>
      </select>

      <template v-if="doc">
        <label class="anim-field">时长
          <NumberField
            :model-value="doc.duration"
            :step="0.1"
            :min="0.1"
            title="剪辑时长（秒）"
            @commit="onDurationChange"
          />
        </label>
        <label class="anim-check" title="循环播放">
          <input type="checkbox" :checked="doc.loops" @change="onLoopsChange($event)" /><span>循环</span>
        </label>

        <span class="anim-sep"></span>
        <button class="anim-btn rec" :class="{ on: recording }" :title="recording ? '停止录制' : '录制：开启后修改节点变换自动 K 帧'" @click="toggleRecording">●</button>
        <button class="anim-btn" :title="playing ? '暂停预览' : '播放预览（应用到选中节点）'" @click="togglePlaying">{{ playing ? "⏸" : "▶" }}</button>
        <button class="anim-btn" title="停止并还原节点姿势" @click="stopPreview">⏹</button>
        <span class="anim-time mono">{{ time.toFixed(2) }}s / {{ doc.duration.toFixed(2) }}s</span>
        <span class="anim-sep"></span>
        <button class="anim-btn" title="全通道 K 帧（当前时间、选中节点当前值）" @click="keyAll">K 全部</button>
        <span class="anim-target" :title="targetNode?.name">
          目标：{{ targetNode ? targetNode.name : "（未选中节点）" }}
        </span>
        <span class="anim-dirty" :class="{ dirty }">{{ saving ? "保存中…" : dirty ? "未保存" : "已保存" }}</span>
      </template>
    </div>

    <!-- 未选择剪辑 -->
    <div v-if="!doc" class="anim-empty">
      在上方选择 .anim 剪辑；没有可在资产面板右键「新建动画」，或给节点添加「动画剪辑」组件后从组件卡打开。
    </div>

    <template v-else>
      <div class="anim-body">
        <!-- 左列：通道名 + K 按钮 -->
        <div class="anim-names">
          <div class="anim-row-head">通道</div>
          <div
            v-for="ch in PROP_CHANNELS"
            :key="ch.prop"
            class="anim-row-head name-row"
            :class="{ on: curveProp === ch.prop }"
            :title="`切换曲线视图到「${ch.label}」（当前 ${keyCount(ch.prop)} 个关键帧）`"
            @click="curveProp = ch.prop"
          >
            <span class="ch-label">{{ ch.label }}</span>
            <button
              class="k-btn"
              :title="`在当前时间 K「${ch.label}」（取选中节点当前值）`"
              @click.stop="keyChannel(ch.prop)"
            >K</button>
          </div>
        </div>

        <!-- 右侧：标尺 + 关键帧轨道 -->
        <div class="anim-lanes" ref="laneEl">
          <div
            class="lane ruler"
            @pointerdown="beginScrub($event)"
            @pointermove="onRulerPointerMove($event)"
            @pointerup="onLanePointerUp()"
          >
            <span
              v-for="tk in rulerTicks"
              :key="tk"
              class="tick mono"
              :style="{ left: tToX(tk, doc.duration) + 'px' }"
            >{{ tk.toFixed(1) }}</span>
            <span class="playhead" :style="{ left: tToX(time, doc.duration) + 'px' }"></span>
          </div>
          <div
            v-for="ch in PROP_CHANNELS"
            :key="ch.prop"
            class="lane key-lane"
            :class="{ on: curveProp === ch.prop }"
            @pointermove="onLanePointerMove($event)"
            @pointerup="onLanePointerUp()"
          >
            <button
              v-for="(k, i) in keysOf(ch.prop)"
              :key="i"
              class="key-dot"
              :class="{ sel: selected?.prop === ch.prop && Math.abs(selected.t - k.t) <= 1e-4 }"
              :style="{ left: tToX(k.t, doc.duration) + 'px' }"
              :title="`${k.t.toFixed(2)}s = ${k.v.toFixed(2)}（${k.i === 'linear' ? '线性' : k.i === 'step' ? '阶跃' : '平滑'}）；拖拽改时间`"
              @pointerdown.stop="beginKeyDrag($event, ch.prop, i)"
              @click.stop="pickKey(ch.prop, k.t)"
            ></button>
            <span class="playhead thin" :style="{ left: tToX(time, doc.duration) + 'px' }"></span>
          </div>
        </div>
      </div>

      <!-- 关键帧操作 + 选中通道曲线视图 -->
      <div class="anim-bottom">
        <div class="anim-keyops">
          <span class="sel-info">
            {{ selected ? `${selected.prop} @ ${selected.t.toFixed(2)}s` : "未选中关键帧" }}
            {{ interpLabel ? `（${interpLabel}）` : "" }}
          </span>
          <button class="anim-btn" :disabled="!selected" title="切换插值：线性 → 阶跃 → 平滑" @click="cycleInterp">插值</button>
          <button class="anim-btn danger" :disabled="!selected" title="删除选中的关键帧" @click="deleteSelected">删除 K</button>
          <span class="anim-hint">曲线视图空白处点击 = 插入关键帧；拖拽关键帧改时间/数值；选中通道见左列高亮</span>
        </div>
        <svg
          ref="curveSvgEl"
          class="anim-curve"
          :viewBox="`0 0 ${curveGeom.w} ${curveGeom.h}`"
          @pointerdown="onCurveDown"
          @pointermove="onCurveMove"
          @pointerup="onCurveUp"
        >
          <line class="c-axis" :x1="curveGeom.pad" :y1="curveGeom.h - curveGeom.pad" :x2="curveGeom.w - curveGeom.pad" :y2="curveGeom.h - curveGeom.pad" />
          <line class="c-axis" :x1="curveGeom.pad" :y1="curveGeom.pad" :x2="curveGeom.pad" :y2="curveGeom.h - curveGeom.pad" />
          <polyline class="c-line" :points="curveGeom.polyline" />
          <rect
            v-for="(k, i) in curveGeom.keys"
            :key="i"
            class="c-key"
            :class="{ sel: selected?.prop === curveProp && Math.abs(selected.t - k.t) <= 1e-4 }"
            :x="curveGeom.xOf(k.t) - 4"
            :y="curveGeom.yOf(k.v) - 4"
            width="8"
            height="8"
          />
        </svg>
      </div>
    </template>
  </div>
</template>

<style scoped src="../../styles/components/anim-editor.scss"></style>
