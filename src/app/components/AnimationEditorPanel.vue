<script setup lang="ts">
// ---------------------------------------------------------------------------
// 动画编辑窗口（底部停靠面板，Unity Animation 窗口的轻量版）：
// - 编辑 .anim 剪辑资产（时长/循环/关键帧），改动防抖自动写盘；
// - 通道不固定：「＋添加属性」按目标节点能力分组添加（变换恒可用；
//   灯光/材质按节点类型提供），轨道只显示已添加的通道（可移除），
//   左列按属性路径建层级树（Transform/Position/X 三级，组行可折叠，
//   折叠后轨道行显示子孙通道关键帧合并概要）；
// - 时间轴：标尺 + 播放头拖拽 scrub + 每通道关键帧轨道（拖拽改时间、点击
//   选中、插值切换、删除）；K 按钮在当前时间 K 选中节点当前值；
// - 录制模式：轮询选中节点，已添加通道的值变化即自动写入关键帧（auto-key）；
// - 预览：播放/scrub 把采样值直接应用到选中节点的三维对象（不写节点数据，
//   非破坏性，停止后还原）；
// - 右侧视图下拉二选一（不同时显示）：帧动画（标尺 + 每通道关键帧轨道）/
//   曲线编辑（单通道曲线占满视图区，时间网格 + 播放头 + 关键帧拖拽/插帧）。
// ---------------------------------------------------------------------------
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as THREE from "three";
import type { Node } from "../../framework/prototype/Node";
import {
  evaluateClip,
  evaluateCurve,
  parseAnimationClip,
  removeKeyAt,
  upsertKey,
  type AnimClipCurve,
  type AnimKeyInterp,
  type AnimationClipData,
  type AnimProp,
} from "../../framework/animation/clip";
import { ANIM_PATHS, animPropGroupsFor, propDefOf } from "../lib/anim-props";
import { getEditorStore } from "../stores/editor";
import { getProjectStore } from "../stores/project";
import { getAssetsStore } from "../stores/assets";
import { api } from "../../lib/api";
import { animEditor } from "../lib/anim-editor";
import NumberField from "./NumberField.vue";
import { openContextMenu, type CtxMenuItem } from "../../lib/editor/context-menu";

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
  curveProp.value = "";
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
    curveProp.value = doc.value.curves[0]?.prop ?? "";
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

/** 按点路径写属性值（"color.r" → target.color.r） */
function setPath(target: unknown, path: string, v: number): void {
  const segs = path.split(".");
  let cur: any = target;
  for (let i = 0; i < segs.length - 1; i++) {
    cur = cur ? cur[segs[i]] : undefined;
    if (cur == null) return;
  }
  if (cur != null) cur[segs[segs.length - 1]] = v;
}

/** 通道分组应用（与播放器 animclip.mjs 的 applyValues 镜像） */
function applyChannels(obj: THREE.Object3D, values: Map<AnimProp, number>): void {
  for (const [prop, v] of values) {
    const i = prop.indexOf(".");
    if (i < 0) continue;
    const group = prop.slice(0, i);
    const path = prop.slice(i + 1);
    if (group === "position" || group === "rotation" || group === "scale") {
      const axis = path as "x" | "y" | "z";
      if (group === "position") obj.position[axis] = v;
      else if (group === "rotation") obj.rotation[axis] = v * D2R;
      else obj.scale[axis] = Math.max(0.001, v);
    } else if (group === "material") {
      const anyObj = obj as unknown as { material?: unknown };
      const m = Array.isArray(anyObj.material) ? anyObj.material[0] : anyObj.material;
      setPath(m, path, v);
    } else if (group === "light") {
      let light: THREE.Light | null = null;
      obj.traverse((o) => {
        if (!light && (o as THREE.Light).isLight) light = o as THREE.Light;
      });
      setPath(light, path, v);
    }
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
let captured = new Map<AnimProp, number>();

function currentValues(node: Node): Map<AnimProp, number> {
  const out = new Map<AnimProp, number>();
  const d = doc.value;
  if (!d) return out;
  for (const c of d.curves) {
    const def = propDefOf(c.prop);
    if (def) out.set(c.prop, def.read(node, engine));
  }
  return out;
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
    const curve = d.curves.find((c) => c.prop === prop);
    if (!curve) continue;
    upsertKey(curve, time.value, v);
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
// 剪辑属性 / 通道（添加属性菜单 + 轨道操作）
// ---------------------------------------------------------------------------
function curveOf(d: AnimationClipData, prop: AnimProp): AnimClipCurve {
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

/** 添加属性菜单（按目标节点能力分组；已添加的通道禁用） */
function onAddPropertyMenu(e: MouseEvent): void {
  const node = targetNode.value;
  const d = doc.value;
  if (!node || !d) return;
  const groups = animPropGroupsFor(node);
  const items: CtxMenuItem[] = [];
  for (const g of groups) {
    items.push({
      label: g.group,
      children: g.items.map((def) => ({
        label: def.label,
        disabled: d.curves.some((c) => c.prop === def.prop),
        onClick: () => addProperty(def.prop),
      })),
    });
  }
  openContextMenu(e, items);
}

function addProperty(prop: AnimProp): void {
  const d = doc.value;
  if (!d) return;
  const curve = curveOf(d, prop);
  if (curve.keys.length === 0) {
    // 新通道：以选中节点当前值在 0s 与当前时间落两帧（无值可读时仅建空曲线）
    const node = targetNode.value;
    const def = propDefOf(prop);
    const v = node && def ? def.read(node, engine) : 0;
    upsertKey(curve, 0, v);
    if (time.value > 1e-4) upsertKey(curve, time.value, v);
  }
  curveProp.value = prop;
  touch();
}

/** 移除通道（连同其关键帧） */
function removeChannel(prop: AnimProp): void {
  const d = doc.value;
  if (!d) return;
  d.curves = d.curves.filter((c) => c.prop !== prop);
  if (curveProp.value === prop) curveProp.value = d.curves[0]?.prop ?? "";
  if (selected.value?.prop === prop) selected.value = null;
  touch();
}

function keyChannel(prop: AnimProp): void {
  const d = doc.value;
  const node = targetNode.value;
  const def = propDefOf(prop);
  if (!d || !node || !def) return;
  upsertKey(curveOf(d, prop), time.value, def.read(node, engine));
  touch();
}

function keyAll(): void {
  const d = doc.value;
  const node = targetNode.value;
  if (!d || !node) return;
  for (const c of d.curves) {
    const def = propDefOf(c.prop);
    if (def) upsertKey(curveOf(d, c.prop), time.value, def.read(node, engine));
  }
  touch();
}

function fullPathOf(prop: AnimProp): string {
  return propDefOf(prop)?.path ?? prop;
}

/** 层级路径展示（Transform › Position › X） */
function pathLabel(prop: AnimProp): string {
  return fullPathOf(prop).split("/").join(" › ");
}

function keysOf(prop: AnimProp): { t: number; v: number; i: AnimKeyInterp }[] {
  void rev.value;
  return doc.value?.curves.find((c) => c.prop === prop)?.keys ?? [];
}

function keyCount(prop: AnimProp): number {
  void rev.value;
  return doc.value?.curves.find((c) => c.prop === prop)?.keys.length ?? 0;
}

/** 已添加通道列表（rev 失效） */
const tracks = computed<AnimClipCurve[]>(() => {
  void rev.value;
  return doc.value?.curves ?? [];
});

// —— 轨道层级树：按属性路径（Transform/Position/X）建组，组可折叠 ——
interface TrackRow {
  kind: "group" | "leaf";
  name: string;
  depth: number;
  /** group = 折叠键（全路径）；leaf = 通道键 */
  key: string;
  /** leaf = 通道键；group = 空串 */
  prop: AnimProp;
  /** group 且已折叠：子孙通道关键帧时刻合并（概要点） */
  times: number[];
}
const collapsedGroups = ref(new Set<string>());

function isGroupCollapsed(pathKey: string): boolean {
  return collapsedGroups.value.has(pathKey);
}
function toggleGroup(pathKey: string): void {
  const next = new Set(collapsedGroups.value);
  if (next.has(pathKey)) next.delete(pathKey);
  else next.add(pathKey);
  collapsedGroups.value = next;
}

/** 目录自然序索引（子级排序：X/Y/Z、R/G/B、Position/Rotation/Scale） */
const ANIM_PATH_RANK = new Map(ANIM_PATHS.map((p, i) => [p, i] as const));

const trackRows = computed<TrackRow[]>(() => {
  void rev.value;
  const d = doc.value;
  const rows: TrackRow[] = [];
  if (!d) return rows;
  interface TNode {
    name: string;
    /** 叶子 = 目录序（未知键 MAX）；组的取值未用（nodeRank 动态算子孙最小） */
    rank: number;
    children: Map<string, TNode>;
    leafProp?: AnimProp;
  }
  const root: TNode = { name: "", rank: -1, children: new Map() };
  for (const c of d.curves) {
    const path = propDefOf(c.prop)?.path ?? c.prop;
    const rank = ANIM_PATH_RANK.get(path) ?? Number.MAX_SAFE_INTEGER;
    const segs = path.split("/");
    let cur = root;
    for (let i = 0; i < segs.length - 1; i++) {
      let next = cur.children.get(segs[i]);
      if (!next) {
        next = { name: segs[i], rank: Number.MAX_SAFE_INTEGER, children: new Map() };
        cur.children.set(segs[i], next);
      }
      cur = next;
    }
    const leafName = segs[segs.length - 1];
    // 目录路径互不相交，叶子与组不会同名冲突；\u0000 前缀仅作 Map 键
    cur.children.set(leafName + "\u0000" + c.prop, {
      name: leafName,
      rank,
      children: new Map(),
      leafProp: c.prop,
    });
  }
  const nodeRank = (tn: TNode): number => {
    if (tn.leafProp) return tn.rank;
    let r = Number.MAX_SAFE_INTEGER;
    for (const ch of tn.children.values()) r = Math.min(r, nodeRank(ch));
    return r;
  };
  const sortedKids = (tn: TNode): TNode[] =>
    [...tn.children.values()].sort(
      (a, b) => nodeRank(a) - nodeRank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
  /** 折叠概要：子孙通道关键帧时刻去重合并 */
  const mergedTimes = (tn: TNode): number[] => {
    const times: number[] = [];
    const collect = (n: TNode): void => {
      if (n.leafProp) {
        const ks = d.curves.find((c) => c.prop === n.leafProp)?.keys ?? [];
        for (const k of ks) if (!times.some((t) => Math.abs(t - k.t) <= 1e-4)) times.push(k.t);
      } else {
        for (const ch of n.children.values()) collect(ch);
      }
    };
    collect(tn);
    times.sort((a, b) => a - b);
    return times;
  };
  const walk = (tn: TNode, depth: number, pathKey: string): void => {
    if (tn.leafProp) {
      rows.push({ kind: "leaf", name: tn.name, depth, key: tn.leafProp, prop: tn.leafProp, times: [] });
      return;
    }
    const collapsed = collapsedGroups.value.has(pathKey);
    rows.push({
      kind: "group",
      name: tn.name,
      depth,
      key: pathKey,
      prop: "",
      times: collapsed ? mergedTimes(tn) : [],
    });
    if (collapsed) return;
    for (const child of sortedKids(tn)) {
      walk(child, depth + 1, pathKey ? pathKey + "/" + child.name : child.name);
    }
  };
  for (const child of sortedKids(root)) walk(child, 1, child.name);
  return rows;
});

const selected = ref<{ prop: AnimProp; t: number } | null>(null);

function pickKey(prop: AnimProp, t: number): void {
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

/** 选中关键帧的插值方式（未选中为空串，下拉禁用） */
const selectedInterp = computed<AnimKeyInterp | "">(() => {
  void rev.value;
  const d = doc.value;
  const sel = selected.value;
  if (!d || !sel) return "";
  const k = d.curves
    .find((c) => c.prop === sel.prop)
    ?.keys.find((kk) => Math.abs(kk.t - sel.t) <= 1e-4);
  return k ? k.i : "";
});

function onInterpChange(e: Event): void {
  const d = doc.value;
  const sel = selected.value;
  if (!d || !sel) return;
  const k = d.curves
    .find((c) => c.prop === sel.prop)
    ?.keys.find((kk) => Math.abs(kk.t - sel.t) <= 1e-4);
  if (!k) return;
  const v = (e.target as HTMLSelectElement).value as AnimKeyInterp;
  if (v === "linear" || v === "step" || v === "smooth") {
    k.i = v;
    touch();
  }
}

// ---------------------------------------------------------------------------
// 视图模式（右侧二选一，下拉切换）：dope = 帧动画轨道；curve = 单通道曲线编辑
// ---------------------------------------------------------------------------
const viewMode = ref<"dope" | "curve">("dope");

function onViewModeChange(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  if (v === "dope" || v === "curve") viewMode.value = v;
}

const viewHint = computed(() =>
  viewMode.value === "dope"
    ? "拖拽关键帧改时间（Alt 关闭吸附）；点击选中后可在左下改插值/删除；点击左侧通道名选中曲线"
    : "空白处点击 = 插入关键帧（Alt 关闭吸附）；拖拽关键帧改时间/数值；点击左侧通道名切换曲线",
);

// ---------------------------------------------------------------------------
// 时间轴几何与指针交互（标尺 scrub + 轨道关键帧拖拽共用换算）
// ---------------------------------------------------------------------------
const laneEl = ref<HTMLElement | null>(null);
const laneWidth = ref(600);
/** 右侧视图区高度（曲线模式 viewBox 用；dope 模式不消费） */
const laneHeight = ref(0);
/** 时间轴缩放倍率（1× = 铺满视图区宽度；仅 dope 视图消费） */
const zoom = ref(1);
const timelineWidth = computed(() => Math.max(1, laneWidth.value) * zoom.value);

function onZoomInput(e: Event): void {
  zoom.value = parseFloat((e.target as HTMLInputElement).value) || 1;
}
let laneRo: ResizeObserver | null = null;
let laneLeftCache = 0;

onMounted(() => {
  laneRo = new ResizeObserver(() => {
    if (laneEl.value) {
      laneWidth.value = laneEl.value.clientWidth;
      laneHeight.value = laneEl.value.clientHeight;
    }
  });
});
// laneEl 在剪辑加载后才渲染（v-else 分支），挂载时通常为 null：
// 必须在 ref 出现时才挂 RO，否则 laneWidth 永远停在初始值（时间轴铺不满）
watch(laneEl, (el) => {
  laneRo?.disconnect();
  if (!el || !laneRo) return;
  laneWidth.value = el.clientWidth;
  laneHeight.value = el.clientHeight;
  laneRo.observe(el);
});
onBeforeUnmount(() => laneRo?.disconnect());

function tToX(t: number, duration: number): number {
  return (t / Math.max(0.1, duration)) * timelineWidth.value;
}
function xToT(x: number, duration: number): number {
  return Math.max(0, Math.min(duration, (x / Math.max(1, timelineWidth.value)) * duration));
}
/** 缩放后指针 x 相对轨道内容原点（需加横向滚动量） */
function laneScrollX(): number {
  return laneEl.value?.scrollLeft ?? 0;
}

// 播放/scrub 时把播放头保持在可视范围内（缩放后内容超出视口才有意义）
watch(time, () => {
  const el = laneEl.value;
  if (!el || viewMode.value !== "dope") return;
  const x = tToX(time.value, doc.value?.duration ?? 1);
  if (x < el.scrollLeft) el.scrollLeft = x;
  else if (x > el.scrollLeft + el.clientWidth - 12) el.scrollLeft = x - el.clientWidth + 12;
});

/** 刻度步长随缩放自适应：按当前每秒像素数选步长，保证刻度间距 ≥ ~80px
 *  （1× 时与原 d/8 行为接近；放大后出现更细的刻度 0.5/0.1/…；
 *  曲线视图不吃缩放，用视口宽计算，避免网格过密） */
const viewWidth = computed(() =>
  viewMode.value === "dope" ? timelineWidth.value : Math.max(1, laneWidth.value),
);
const rulerStep = computed(() => {
  const d = doc.value?.duration ?? 3;
  const pxPerSec = viewWidth.value / Math.max(0.1, d);
  const steps = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60];
  return steps.find((s) => s * pxPerSec >= 80) ?? 60;
});

/** 标签小数位跟随步长（0.05→2 位、0.2→1 位、1s→整数） */
const tickDecimals = computed(() => {
  const s = rulerStep.value;
  const dec = -Math.floor(Math.log10(s + 1e-9));
  return Math.min(2, Math.max(0, dec));
});

function tickLabel(t: number): string {
  return t.toFixed(tickDecimals.value);
}

const rulerTicks = computed<number[]>(() => {
  const d = doc.value?.duration ?? 3;
  const step = rulerStep.value;
  const out: number[] = [];
  // 用整数索引乘步长，避免浮点累加漂移出重复刻度
  for (let i = 0; i * step <= d + 1e-6; i++) out.push(i * step);
  return out;
});

/** 时间吸附（工具条开关，按住 Alt 临时关闭）：对齐到刻度步长的 1/10 细分网格 */
const snapEnabled = ref(true);

function snapT(t: number, duration: number, enabled: boolean): number {
  if (!enabled) return t;
  const grid = Math.max(0.001, rulerStep.value / 10);
  return Math.max(0, Math.min(duration, Math.round(t / grid) * grid));
}

type Drag =
  | { kind: "scrub" }
  | { kind: "key"; prop: AnimProp; index: number; startX: number; live: boolean }
  | null;
let drag: Drag = null;
function beginScrub(e: PointerEvent): void {
  const rect = laneEl.value?.getBoundingClientRect();
  if (!rect) return;
  laneLeftCache = rect.left;
  drag = { kind: "scrub" };
  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  const dur = doc.value?.duration ?? 1;
  time.value = snapT(xToT(e.clientX - rect.left + laneScrollX(), dur), dur, snapEnabled.value && !e.altKey);
  previewAt(time.value);
}

function beginKeyDrag(e: PointerEvent, prop: AnimProp, index: number): void {
  const rect = laneEl.value?.getBoundingClientRect();
  if (!rect) return;
  laneLeftCache = rect.left;
  // 选中在按下时即生效（不依赖 click：拖拽后数组重排，click 会命中错误的帧）
  pickKey(prop, keysOf(prop)[index]?.t ?? 0);
  drag = { kind: "key", prop, index, startX: e.clientX - laneLeftCache + laneScrollX(), live: false };
  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
}

function onRulerPointerMove(e: PointerEvent): void {
  if (!drag || drag.kind !== "scrub") return;
  const d = doc.value;
  if (!d) return;
  time.value = snapT(xToT(e.clientX - laneLeftCache + laneScrollX(), d.duration), d.duration, snapEnabled.value && !e.altKey);
  previewAt(time.value);
}

function onLanePointerMove(e: PointerEvent): void {
  if (!drag || drag.kind !== "key") return;
  const d = doc.value;
  if (!d) return;
  // drag 为模块级可变量：捕获到局部常量保持 TS 收窄，字段仍可写
  const dragKey = drag;
  const x = e.clientX - laneLeftCache + laneScrollX();
  // 死区：按下未移动超过 3px 视为点击，不动关键帧
  if (!dragKey.live) {
    if (Math.abs(x - dragKey.startX) < 3) return;
    dragKey.live = true;
  }
  const curve = d.curves.find((c) => c.prop === dragKey.prop);
  const key = curve?.keys[dragKey.index];
  if (!key || !curve) return;
  key.t = snapT(xToT(x, d.duration), d.duration, snapEnabled.value && !e.altKey);
  curve.keys.sort((a, b) => a.t - b.t);
  // 排序后必须回写索引，否则下一次移动事件会抓到别的关键帧
  dragKey.index = curve.keys.indexOf(key);
  selected.value = { prop: dragKey.prop, t: key.t };
  touch();
}

function onLanePointerUp(): void {
  drag = null;
}

// ---------------------------------------------------------------------------
// 曲线视图（选中通道）：SVG 曲线 + 关键帧拖拽 + 空白点击插帧
// ---------------------------------------------------------------------------
const curveSvgEl = ref<SVGSVGElement | null>(null);

const curveProp = ref<AnimProp>("");

const curveGeom = computed(() => {
  void rev.value;
  const d = doc.value;
  const curve = d?.curves.find((c) => c.prop === curveProp.value) ?? null;
  const keys = curve?.keys ?? [];
  // viewBox 与元素实测尺寸严格一致（width/height:100%）：保证指针像素坐标
  // 与 viewBox 坐标 1:1，命中判定不偏移；不能加尺寸下限（会破坏等比）
  const w = Math.max(1, laneWidth.value);
  const h = Math.max(1, laneHeight.value);
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
  // xOf 的逆映射（点击/拖拽换算 t；与绘制同套几何，不能用全宽的 xToT）
  const tOf = (x: number) =>
    d
      ? Math.max(
          0,
          Math.min(d.duration, ((x - pad) / Math.max(1, w - pad * 2)) * d.duration),
        )
      : 0;
  const polyline: string[] = [];
  if (keys.length && d) {
    const N = 120;
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * d.duration;
      const v = evaluateCurve(curve as AnimClipCurve, t);
      if (v !== null) polyline.push(`${xOf(t).toFixed(1)},${yOf(v).toFixed(1)}`);
    }
  }
  return { w, h, pad, lo, hi, xOf, yOf, tOf, keys, polyline: polyline.join(" ") };
});

type CurveDrag = { index: number; startX: number; startY: number; live: boolean } | null;
let curveDrag: CurveDrag = null;

function onCurveDown(e: PointerEvent): void {
  const d = doc.value;
  const svg = curveSvgEl.value;
  if (!d || !svg) return;
  const r = svg.getBoundingClientRect();
  const g = curveGeom.value;
  const localX = e.clientX - r.left;
  const localY = e.clientY - r.top;
  // 命中 = 到关键帧中心的二维距离（不只 x；否则相邻 t 不同 v 的点选不中）
  const hit = g.keys.find(
    (k) => Math.hypot(g.xOf(k.t) - localX, g.yOf(k.v) - localY) < 9,
  );
  if (hit) {
    pickKey(curveProp.value, hit.t);
    // live=false：先按点击处理，移出死区才转拖拽（防止点选时的抖动改值）
    curveDrag = { index: g.keys.indexOf(hit), startX: localX, startY: localY, live: false };
  } else {
    const t = snapT(g.tOf(localX), d.duration, snapEnabled.value && !e.altKey);
    const v = g.lo + ((g.h - g.pad - localY) / Math.max(1, g.h - g.pad * 2)) * (g.hi - g.lo);
    const curve = curveOf(d, curveProp.value);
    upsertKey(curve, t, v);
    pickKey(curveProp.value, t);
    curveDrag = {
      index: curve.keys.findIndex((k) => Math.abs(k.t - t) <= 1e-4),
      startX: localX,
      startY: localY,
      live: true,
    };
    touch();
  }
  svg.setPointerCapture?.(e.pointerId);
}

function onCurveMove(e: PointerEvent): void {
  const d = doc.value;
  const dragNow = curveDrag;
  if (!dragNow || !d || !curveSvgEl.value) return;
  const r = curveSvgEl.value.getBoundingClientRect();
  const g = curveGeom.value;
  const localX = e.clientX - r.left;
  const localY = e.clientY - r.top;
  if (!dragNow.live) {
    if (Math.hypot(localX - dragNow.startX, localY - dragNow.startY) < 3) return;
    dragNow.live = true;
  }
  const curve = d.curves.find((c) => c.prop === curveProp.value);
  const key = curve?.keys[dragNow.index];
  if (!curve || !key) return;
  key.t = snapT(g.tOf(localX), d.duration, snapEnabled.value && !e.altKey);
  key.v = g.lo + ((g.h - g.pad - localY) / Math.max(1, g.h - g.pad * 2)) * (g.hi - g.lo);
  curve.keys.sort((a, b) => a.t - b.t);
  dragNow.index = curve.keys.indexOf(key);
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
        <button class="anim-btn rec" :class="{ on: recording }" :title="recording ? '停止录制' : '录制：开启后修改节点变换自动 K 帧（已添加通道）'" @click="toggleRecording">●</button>
        <button class="anim-btn" :title="playing ? '暂停预览' : '播放预览（应用到选中节点）'" @click="togglePlaying">{{ playing ? "⏸" : "▶" }}</button>
        <button class="anim-btn" title="停止并还原节点姿势" @click="stopPreview">⏹</button>
        <button
          class="anim-btn"
          :class="{ on: snapEnabled }"
          title="时间吸附：scrub 与关键帧拖拽对齐到刻度细分网格（按住 Alt 临时关闭）"
          @click="snapEnabled = !snapEnabled"
        >吸附</button>
        <span class="anim-time mono">{{ time.toFixed(2) }}s / {{ doc.duration.toFixed(2) }}s</span>
        <span class="anim-sep"></span>
        <button class="anim-btn" title="为所有已添加通道 K 帧（当前时间、选中节点当前值）" @click="keyAll">K 全部</button>
        <span class="anim-target" :title="targetNode?.name">
          目标：{{ targetNode ? targetNode.name : "（未选中节点）" }}
        </span>
        <span class="anim-dirty" :class="{ dirty }">{{ saving ? "保存中…" : dirty ? "未保存" : "已保存" }}</span>
        <select
          class="anim-view-pick"
          :value="viewMode"
          title="视图模式：帧动画关键帧轨道 / 单通道曲线编辑（二选一显示）"
          @change="onViewModeChange($event)"
        >
          <option value="dope">帧动画</option>
          <option value="curve">曲线编辑</option>
        </select>
      </template>
    </div>

    <!-- 未选择剪辑 -->
    <div v-if="!doc" class="anim-empty">
      在上方选择 .anim 剪辑；没有可在资产面板右键「新建动画」，或给节点添加「动画剪辑」组件后从组件卡打开。
    </div>

    <template v-else>
      <div class="anim-body">
        <!-- 左列：添加属性 + 层级轨道树（组可折叠，叶子 = 通道） -->
        <div class="anim-names">
          <div class="anim-row-head head-label">通道</div>
          <template v-for="row in trackRows" :key="row.kind + row.key">
            <!-- 组行：点击折叠/展开 -->
            <div
              v-if="row.kind === 'group'"
              class="anim-row-head group-row"
              :style="{ paddingLeft: 4 + row.depth * 12 + 'px' }"
              @click="toggleGroup(row.key)"
            >
              <span class="h-caret-mini">{{ isGroupCollapsed(row.key) ? "▸" : "▾" }}</span>
              <span class="ch-label">{{ row.name }}</span>
            </div>
            <!-- 叶子行：通道（K / 移除 / 点选曲线视图） -->
            <div
              v-else
              class="anim-row-head name-row"
              :class="{ on: curveProp === row.prop }"
              :style="{ paddingLeft: 4 + row.depth * 12 + 'px' }"
              :title="fullPathOf(row.prop) + ' · ' + keyCount(row.prop) + ' 关键帧'"
              @click="curveProp = row.prop"
            >
              <span class="ch-label">{{ row.name }}</span>
              <button
                class="k-btn"
                title="在当前时间 K（取选中节点当前值）"
                @click.stop="keyChannel(row.prop)"
              >K</button>
              <button
                class="k-btn del"
                title="移除该通道（连同其全部关键帧）"
                @click.stop="removeChannel(row.prop)"
              >✕</button>
            </div>
          </template>
          <button class="add-prop-btn" title="为剪辑添加可动画属性（按选中节点能力提供）" @click.stop="onAddPropertyMenu($event)">＋ 添加属性</button>
        </div>

        <!-- 右侧视图区：帧动画轨道 / 曲线编辑（下拉切换，二选一显示） -->
        <div class="anim-lanes" ref="laneEl">
          <template v-if="viewMode === 'dope'">
            <div class="lane-wrap" :style="{ width: timelineWidth + 'px' }">
            <div
              class="lane ruler"
              @pointerdown="beginScrub($event)"
              @pointermove="onRulerPointerMove($event)"
              @pointerup="onLanePointerUp()"
              @pointercancel="onLanePointerUp()"
            >
              <span
                v-for="tk in rulerTicks"
                :key="tk"
                class="tick mono"
                :style="{ left: tToX(tk, doc.duration) + 'px' }"
              >{{ tickLabel(tk) }}</span>
              <span class="playhead" :style="{ left: tToX(time, doc.duration) + 'px' }"></span>
            </div>
            <template v-for="row in trackRows" :key="row.kind + row.key">
              <!-- 组行轨道：展开 = 占位；折叠 = 子孙关键帧合并概要 -->
              <div v-if="row.kind === 'group'" class="lane group-spacer" :title="isGroupCollapsed(row.key) ? `${row.times.length} 个关键帧（子通道合并）` : undefined">
                <template v-if="isGroupCollapsed(row.key)">
                  <span
                    v-for="t in row.times"
                    :key="t"
                    class="key-dot dim"
                    :style="{ left: tToX(t, doc.duration) + 'px' }"
                  ></span>
                  <span class="playhead thin" :style="{ left: tToX(time, doc.duration) + 'px' }"></span>
                </template>
              </div>
              <!-- 叶子行：通道关键帧（按下即选中，拖拽改时间） -->
              <div
                v-else
                class="lane key-lane"
                :class="{ on: curveProp === row.prop }"
                @pointermove="onLanePointerMove($event)"
                @pointerup="onLanePointerUp()"
                @pointercancel="onLanePointerUp()"
              >
                <button
                  v-for="(k, i) in keysOf(row.prop)"
                  :key="i"
                  class="key-dot"
                  :class="{ sel: selected?.prop === row.prop && Math.abs(selected.t - k.t) <= 1e-4 }"
                  :style="{ left: tToX(k.t, doc.duration) + 'px' }"
                  :title="`${k.t.toFixed(2)}s = ${k.v.toFixed(2)}（${k.i === 'linear' ? '线性' : k.i === 'step' ? '阶跃' : '平滑'}）；拖拽改时间`"
                  @pointerdown.stop="beginKeyDrag($event, row.prop, i)"
                ></button>
                <span class="playhead thin" :style="{ left: tToX(time, doc.duration) + 'px' }"></span>
              </div>
            </template>
            <div v-if="tracks.length === 0" class="hint lane-empty">
              尚未添加属性：点击左下「＋ 添加属性」（变换 / 灯光 / 材质按节点能力提供）
            </div>
            </div>
          </template>
          <template v-else>
            <div v-if="tracks.length === 0" class="hint lane-empty">
              尚未添加属性：点击左下「＋ 添加属性」（变换 / 灯光 / 材质按节点能力提供）
            </div>
            <div v-else-if="!curveProp" class="hint lane-empty">点击左侧通道名显示其曲线</div>
            <template v-else>
              <div class="curve-title mono">{{ pathLabel(curveProp) }}</div>
              <svg
                ref="curveSvgEl"
                class="anim-curve"
                :viewBox="`0 0 ${curveGeom.w} ${curveGeom.h}`"
                @pointerdown="onCurveDown"
                @pointermove="onCurveMove"
                @pointerup="onCurveUp"
                @pointercancel="onCurveUp"
              >
                <line
                  v-for="tk in rulerTicks"
                  :key="tk"
                  class="c-grid"
                  :x1="curveGeom.xOf(tk)"
                  :y1="curveGeom.pad"
                  :x2="curveGeom.xOf(tk)"
                  :y2="curveGeom.h - curveGeom.pad"
                />
                <line class="c-playhead" :x1="curveGeom.xOf(time)" :y1="0" :x2="curveGeom.xOf(time)" :y2="curveGeom.h" />
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
            </template>
          </template>
        </div>
      </div>

      <!-- 关键帧操作条（两种视图共用：插值下拉 + 删除） -->
      <div class="anim-bottom">
        <div class="anim-keyops">
          <select
            class="interp-pick"
            :value="selectedInterp"
            :disabled="!selected"
            title="选中关键帧的插值方式"
            @change="onInterpChange($event)"
          >
            <option value="" disabled>（未选中关键帧）</option>
            <option value="linear">线性</option>
            <option value="step">阶跃</option>
            <option value="smooth">平滑</option>
          </select>
          <button class="anim-btn danger" :disabled="!selected" title="删除选中的关键帧" @click="deleteSelected">删除 K</button>
          <span class="anim-hint">{{ viewHint }}</span>
          <label class="zoom-ctl" title="缩放时间轴轨道（1× 铺满视图区宽度，放大后可横向滚动）">
            <input type="range" min="1" max="8" step="0.5" :value="zoom" @input="onZoomInput" />
            <span class="mono">×{{ zoom.toFixed(1) }}</span>
          </label>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped src="../../styles/components/anim-editor.scss"></style>
