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
//   曲线编辑（单通道曲线占满视图区，时间网格 + 播放头 + 关键帧拖拽/插帧 +
//   Unity 风格贝塞尔切线手柄：自动态虚影、拖动即固化、tm 对称联动、右键菜单
//   切换插值/对称/断开/压平/删除；dope 轨道关键帧右键共用同一菜单；
//   时间窗与鼠标方案两视图完全统一（底部「×」滑条 / 滚轮以指针为中心缩放 /
//   Ctrl+滚轮平移；中键拖拽二维平移：dope 横=时间窗、纵=轨道滚动条，
//   曲线横=时间窗、纵=数值窗；数值轴另配「值×」滑条与「适配」复位），
//   窗口外曲线自动钳值延长线，越界手柄被裁剪）。
// ---------------------------------------------------------------------------
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as THREE from "three";
import type { Node } from "../../framework/prototype/Node";
import {
  clampSlope,
  clearTangents,
  ensureManualTangents,
  evaluateClip,
  evaluateCurve,
  isAutoTangent,
  keySlope,
  parseAnimationClip,
  removeKeyAt,
  upsertKey,
  type AnimClipCurve,
  type AnimKey,
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
import { menuSeparator, openContextMenu, type CtxMenuItem } from "../../lib/editor/context-menu";

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
  // 切剪辑：曲线数值窗与共享时间窗复位
  curveView.value = null;
  curveZoom.value = 1;
  curveViewFreeze = null;
  tlT0.value = 0;
  zoom.value = 1;
  if (laneEl.value) laneEl.value.scrollTop = 0;
  if (namesEl.value) namesEl.value.scrollTop = 0;
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
  // 时长变了重新钳共享时间窗（窗口宽 = 时长/zoom）并同步 dope 滚动位置
  applyT0(tlT0.value, zoom.value);
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

/** 选中关键帧的插值方式：平滑且自动切线显示为虚拟态 "auto"；未选中为空串 */
const selectedInterp = computed<AnimKeyInterp | "auto" | "">(() => {
  void rev.value;
  const d = doc.value;
  const sel = selected.value;
  if (!d || !sel) return "";
  const k = d.curves
    .find((c) => c.prop === sel.prop)
    ?.keys.find((kk) => Math.abs(kk.t - sel.t) <= 1e-4);
  if (!k) return "";
  return k.i === "smooth" && isAutoTangent(k) ? "auto" : k.i;
});

function onInterpChange(e: Event): void {
  const d = doc.value;
  const sel = selected.value;
  if (!d || !sel) return;
  const k = d.curves
    .find((c) => c.prop === sel.prop)
    ?.keys.find((kk) => Math.abs(kk.t - sel.t) <= 1e-4);
  if (!k) return;
  const v = (e.target as HTMLSelectElement).value;
  if (v === "auto") {
    k.i = "smooth";
    clearTangents(k);
    touch();
    return;
  }
  if (v === "linear" || v === "step") {
    k.i = v;
    clearTangents(k); // 线性/阶跃不使用切线：清除避免残留
    touch();
    return;
  }
  if (v === "smooth") {
    setInterp(sel.prop, sel.t, "smooth");
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
    ? "滚轮缩放时间轴 / Ctrl 滚轮平移；中键拖拽平移（横=时间窗，1× 全览时向左拖自动放大；纵=翻轨道）；右键关键帧：插值/切线/删除"
    : "与帧动画同一套鼠标方案：滚轮缩放时间轴 / Ctrl 滚轮平移 / 中键拖拽平移（纵向平移数值轴）；拖方块改时间/数值，拖切线手柄调贝塞尔；空白单击插帧；右键关键帧弹菜单",
);

// ---------------------------------------------------------------------------
// 时间轴几何与指针交互（dope / 曲线两视图共用一套时间窗）：
// 窗口 = [t0, t0 + 时长/zoom]。dope 侧以内容层（宽 = 全时长×倍率）+ scrollLeft
// 承载，曲线侧以 viewBox 线性映射消费同一窗口；底部「×」滑条、两个视图的
// 滚轮（以指针为中心缩放，Ctrl+滚轮 = 平移）都驱动同一状态，互相同步。
// ---------------------------------------------------------------------------
const laneEl = ref<HTMLElement | null>(null);
/** 左列通道名面板（与轨道区纵向滚动同步保持行对齐） */
const namesEl = ref<HTMLElement | null>(null);
const laneWidth = ref(600);
/** 右侧视图区高度（曲线模式 viewBox 用；dope 模式不消费） */
const laneHeight = ref(0);
/** 时间轴缩放倍率（1× = 全时长铺满视图区宽度；两视图共享） */
const zoom = ref(1);
/** 可视时间窗原点（秒；dope 侧由 scrollLeft 派生，此处为曲线/编程设置的权威值） */
const tlT0 = ref(0);

const pxPerT0 = computed(() => Math.max(1, laneWidth.value) / Math.max(0.1, doc.value?.duration ?? 1));
/** dope 内容层总宽（= 全时长 × 倍率：zoom=1 恰好铺满） */
const timelineWidth = computed(() => Math.max(0.1, doc.value?.duration ?? 1) * zoom.value * pxPerT0.value);
/** 缩放后指针 x 相对轨道内容原点（需加横向滚动量） */
function laneScrollX(): number {
  return laneEl.value?.scrollLeft ?? 0;
}
/** 可视时间窗（权威状态 tlT0；dope 滚动条通过 @scroll 写回，两视图共享） */
const tWindow = computed<{ t0: number; t1: number }>(() => {
  const dur = Math.max(0.1, doc.value?.duration ?? 3);
  const span = dur / zoom.value;
  const t0 = Math.min(Math.max(tlT0.value, 0), Math.max(0, dur - span));
  return { t0, t1: t0 + span };
});

/** 写窗口原点（同步 dope 滚动位置与权威 tlT0） */
function applyT0(t0: number, z: number): void {
  const dur = Math.max(0.1, doc.value?.duration ?? 3);
  const span = dur / z;
  const clamped = span >= dur * 0.999 ? 0 : Math.min(Math.max(t0, 0), Math.max(0, dur - span));
  const el = laneEl.value;
  if (el) el.scrollLeft = clamped * z * pxPerT0.value;
  tlT0.value = clamped;
  zoom.value = z;
}

/** 视图切换时同步 dope 滚动位置与 tlT0（两视图共用时间窗） */
function syncTimeWindow(): void {
  const el = laneEl.value;
  if (!el) return;
  if (viewMode.value === "dope") {
    tlT0.value = laneScrollX() / Math.max(1e-6, zoom.value * pxPerT0.value);
  } else {
    const dur = Math.max(0.1, doc.value?.duration ?? 3);
    const span = dur / zoom.value;
    tlT0.value = Math.min(Math.max(tlT0.value, 0), Math.max(0, dur - span));
    el.scrollLeft = tlT0.value * zoom.value * pxPerT0.value;
  }
}
watch(viewMode, syncTimeWindow);

/** 统一改倍率（保持锚点：anchorT 时刻停在视图相对位置 anchorFrac 处） */
function setTWindow(zNew: number, anchorFrac: number, anchorT: number): void {
  const dur = Math.max(0.1, doc.value?.duration ?? 3);
  const z = Math.min(8, Math.max(1, zNew));
  applyT0(anchorT - anchorFrac * (dur / z), z);
}

/** 滚轮共享处理（dope / 曲线视图都接这里；frac = 指针在视图绘图区相对位置 0~1）：
 *  默认滚轮缩放时间轴（指针时刻不动）；Ctrl+滚轮平移；Shift+滚轮不拦截（原生横滚） */
function timelineWheel(e: WheelEvent, frac: number): void {
  const win = tWindow.value;
  const span = win.t1 - win.t0;
  const anchorT = win.t0 + frac * span;
  if (e.ctrlKey) {
    const px = Math.max(1, laneWidth.value);
    const dx = (e.deltaY || e.deltaX) * (span / px);
    applyT0(win.t0 + dx, zoom.value);
    return;
  }
  const f = Math.exp(e.deltaY * 0.0015); // 滚上 = 放大（窗口变小）
  setTWindow(zoom.value / f, frac, anchorT);
}

/** dope 轨道区滚轮 */
function onLaneWheel(e: WheelEvent): void {
  if (!laneEl.value || !doc.value) return;
  if (e.shiftKey && !e.ctrlKey) return;
  e.preventDefault();
  const r = laneEl.value.getBoundingClientRect();
  timelineWheel(e, (e.clientX - r.left) / Math.max(1, r.width));
}

function onZoomInput(e: Event): void {
  // 滑条改倍率：以可视窗中心为锚
  const win = tWindow.value;
  setTWindow(parseFloat((e.target as HTMLInputElement).value) || 1, 0.5, (win.t0 + win.t1) / 2);
}

// —— 中键拖拽平移时间窗（dope：标尺/轨道/内容层按下全局接管；曲线：见 CurveDrag pan）——
let panUp: (() => void) | null = null;
/** 同一 pointerdown 事件对象（冒泡多路径重入）按事件去重——
 *  不可用 pointerId：鼠标 pointerId 恒定，一次 pointerup 丢失（如窗外释放）
 *  会让基于 pointerId 的重入闸永久拦截后续所有中键 */
const panHandled = new WeakSet<PointerEvent>();
/** 平移中状态：必须走响应式 :class（命令式 classList 会被 Vue 重渲染冲掉） */
const lanePanning = ref(false);
/** 从指针 clientX 求窗口原点增量（÷ 1× 像素密度：平移结果与缩放倍率无关） */
function tlDxFromClientX(x: number): number {
  return (x - laneLeftCache) / Math.max(1e-6, pxPerT0.value);
}
/** 内容层冒泡兜底：标尺/关键帧之外的空白按中键也能平移（同指针事件已在别处处理则跳过） */
function onWrapPointerDown(e: PointerEvent): void {
  if (e.button === 1) beginLanePan(e);
}

/** 双向 scrollTop 同步防回环：本标志为 true 期间的 scroll 事件是程序写入产生的 */
let syncingScroll = false;

/** 右列滚动：横向写回共享时间窗 tlT0；纵向同步左列（防回环） */
function onLanesScroll(): void {
  const el = laneEl.value;
  if (!el) return;
  if (viewMode.value === "dope") {
    tlT0.value = laneScrollX() / Math.max(1e-6, zoom.value * pxPerT0.value);
  }
  if (syncingScroll) {
    syncingScroll = false;
    return;
  }
  const names = namesEl.value;
  if (names && names.scrollTop !== el.scrollTop) {
    syncingScroll = true;
    names.scrollTop = el.scrollTop;
  }
}

/** 左列（通道名）滚动：把纵向位置同步给右列轨道区 */
function onNamesScroll(): void {
  const names = namesEl.value;
  if (!names) return;
  if (syncingScroll) {
    syncingScroll = false;
    return;
  }
  const el = laneEl.value;
  if (el && el.scrollTop !== names.scrollTop) {
    syncingScroll = true;
    el.scrollTop = names.scrollTop;
  }
}

/** 平移期间拦截中键默认行为（Chromium/WebView2 的中键自动滚动与拖拽：
 *  仅 pointerdown preventDefault 在部分版本压不住，mousedown/auxclick 阶段兜底） */
function panSuppress(e: Event): void {
  e.preventDefault();
}

function beginLanePan(e: PointerEvent): void {
  const el = laneEl.value;
  if (!el || !doc.value || viewMode.value !== "dope") return;
  // 重入闸：同一 pointerdown 冒泡经过多条处理路径（ruler→wrap 等），按事件对象去重
  if (panHandled.has(e)) return;
  panHandled.add(e);
  // 自愈：上次平移若丢了 pointerup（窗外释放等），先清理再开始
  panUp?.();
  // 捕获到滚动容器自身（与曲线捕获到 svg 一致）：拖拽期间浏览器按捕获元素的
  // 光标渲染，容器带 panning → grabbing 小手，指针压在标尺/关键帧上也不例外
  el.setPointerCapture?.(e.pointerId);
  laneLeftCache = e.clientX; // 平移按「相对按下点」计算（若用容器左缘，按下瞬间会跳一段）
  const startX = e.clientX;
  const startT0 = tWindow.value.t0;
  const startTop = el.scrollTop;
  const startY = e.clientY;
  lanePanning.value = true;
  const move = (ev: PointerEvent): void => {
    if (ev.buttons === 0) return; // 中键已松开（边缘情况：up 未送达）
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (zoom.value === 1 && dx < 0) {
      // 1× 全览没有横向平移余量：水平拖出 80px 未动 → 自动放大一级（以视口中心
      // 为锚），继续拖动即为平移；纵向拖拽不受影响
      if (-dx > 80) {
        setTWindow(zoom.value + 1, 0.5, (tWindow.value.t0 + tWindow.value.t1) / 2);
        laneLeftCache = ev.clientX; // 从当前位置重新计平移起点（startX 保持供纵向）
      }
    } else {
      applyT0(startT0 - tlDxFromClientX(ev.clientX), zoom.value);
    }
    // 纵向 = 抓画布滚轨道（内容跟指针走）
    el.scrollTop = Math.max(0, startTop - dy);
  };
  const cleanup = (): void => {
    lanePanning.value = false;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", cleanup);
    window.removeEventListener("pointercancel", cleanup);
    window.removeEventListener("mousedown", panSuppress, true);
    window.removeEventListener("auxclick", panSuppress, true);
    window.removeEventListener("dragstart", panSuppress, true);
    panUp = null;
  };
  panUp = cleanup;
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", cleanup);
  window.addEventListener("pointercancel", cleanup);
  window.addEventListener("mousedown", panSuppress, true);
  window.addEventListener("auxclick", panSuppress, true);
  window.addEventListener("dragstart", panSuppress, true);
  e.preventDefault();
}

onBeforeUnmount(() => {
  // 面板销毁时仍有按住的中键：清理全局平移监听
  panUp?.();
});
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

// 播放/scrub 时把播放头保持在可视范围内（缩放后内容超出视口才有意义）
watch(time, () => {
  const el = laneEl.value;
  if (!el || viewMode.value !== "dope") return;
  const x = tToX(time.value, doc.value?.duration ?? 1);
  if (x < el.scrollLeft) el.scrollLeft = x;
  else if (x > el.scrollLeft + el.clientWidth - 12) el.scrollLeft = x - el.clientWidth + 12;
});

/** 刻度步长随缩放自适应：按当前时间窗的每秒像素数选步长，保证刻度间距 ≥ ~80px
 *  （1× 时与原 d/8 行为接近；放大后出现更细的刻度，两视图共享同一时间窗） */
const rulerStep = computed(() => {
  const { t0, t1 } = tWindow.value;
  const pxPerSec = Math.max(1, laneWidth.value) / Math.max(0.1, t1 - t0);
  const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60];
  return steps.find((s) => s * pxPerSec >= 80) ?? 60;
});

/** 已缩放（时间窗 < 全时长）→ 曲线网格加 1/5 细线 */
const tlZoomed = computed(() => zoom.value > 1.001);

/** 标签小数位跟随步长（0.05→2 位、0.2→1 位、1s→整数） */
const tickDecimals = computed(() => {
  const s = rulerStep.value;
  const dec = -Math.floor(Math.log10(s + 1e-9));
  return Math.min(2, Math.max(0, dec));
});

function tickLabel(t: number): string {
  return t >= 0 ? t.toFixed(tickDecimals.value) : "-" + (-t).toFixed(tickDecimals.value);
}

const rulerTicks = computed<number[]>(() => {
  const { t0, t1 } = tWindow.value;
  const step = rulerStep.value;
  const out: number[] = [];
  // 用整数索引乘步长，避免浮点累加漂移出重复刻度（只生成可视窗内刻度）
  for (let i = Math.ceil(t0 / step - 1e-6); i * step <= t1 + 1e-6; i++) out.push(i * step);
  return out;
});

/** 曲线视图网格 = 主刻度 + 缩放态 1/5 细刻度 */
const curveGridTicks = computed<number[]>(() => {
  const majors = rulerTicks.value;
  if (!tlZoomed.value) return majors;
  const { t0, t1 } = tWindow.value;
  const minor = rulerStep.value / 5;
  const out = [...majors];
  for (let i = Math.ceil(t0 / minor - 1e-6); i * minor <= t1 + 1e-6; i++) {
    const t = i * minor;
    if (!majors.some((m) => Math.abs(m - t) < minor / 2)) out.push(t);
  }
  return out.sort((a, b) => a - b);
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
  if (e.button === 1) return beginLanePan(e); // 中键 = 平移视图
  if (e.button !== 0) return;
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
  if (e.button === 1) return beginLanePan(e); // 中键 = 平移视图（不选中关键帧）
  if (e.button !== 0) return; // 右键按下留给 contextmenu 菜单，不进拖拽
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

/** Hermite 段插值（与 framework clip.ts evaluateCurve 同一公式；m = 斜率×段跨） */
function hermite(k1: AnimKey, m1: number, k2: AnimKey, m2: number, u: number): number {
  const u2 = u * u;
  const u3 = u2 * u;
  return (
    (2 * u3 - 3 * u2 + 1) * k1.v +
    (u3 - 2 * u2 + u) * m1 +
    (-2 * u3 + 3 * u2) * k2.v +
    (u3 - u2) * m2
  );
}

/** 切线手柄绘制条目 */
interface TangentHandle {
  index: number;
  side: "ti" | "to";
  x: number;
  y: number;
  /** 手动态 = 实心可拖；自动态 = 虚影提示 */
  manual: boolean;
  /** 联动（tm）的非选中侧：弱化显示 */
  ghost: boolean;
}

/** 曲线视图数值轴窗口（null = 自动适配；时间轴走共享的 tlT0/zoom 窗口） */
const curveView = ref<{ lo: number; hi: number } | null>(null);
/** 数值轴缩放滑条倍率（0.2 = 视野缩到 1/5 即放大 5 倍，4 = 拉远 4 倍） */
const curveZoom = ref(1);

/** 自动适配值域：关键帧值 + smooth 曲线鼓包极值 + 播放头采样值（保证可以其为中心缩放） */
function fitCurveView(): { lo: number; hi: number } {
  const d = doc.value;
  const curve = d?.curves.find((c) => c.prop === curveProp.value) ?? null;
  const keys = curve?.keys ?? [];
  let lo = 0;
  let hi = 0;
  if (keys.length) {
    lo = Math.min(...keys.map((k) => k.v));
    hi = Math.max(...keys.map((k) => k.v));
    // smooth 段可能鼓出关键帧值之外：8 等分采样纳入曲线极值
    for (let i = 0; i + 1 < keys.length; i++) {
      const k1 = keys[i];
      const k2 = keys[i + 1];
      if (k1.i !== "smooth") continue;
      const span = Math.max(1e-6, k2.t - k1.t);
      const m1 = keySlope(keys, i, "to") * span;
      const m2 = keySlope(keys, i + 1, "ti") * span;
      for (let s = 1; s < 8; s++) {
        const v = hermite(k1, m1, k2, m2, s / 8);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
  }
  if (hi - lo < 1e-6) {
    lo -= 1;
    hi += 1;
  } else {
    const padV = (hi - lo) * 0.15;
    lo -= padV;
    hi += padV;
  }
  // 播放头采样值纳入视野（滚轮以其为中心缩放；鼓包出界时可播放过去再放大）
  if (curve) {
    const pv = evaluateCurve(curve, time.value);
    if (pv !== null) {
      if (pv < lo) lo = pv - (hi - lo) * 0.05;
      if (pv > hi) hi = pv + (hi - lo) * 0.05;
    }
  }
  return { lo, hi };
}

/** 应用数值缩放：以播放头当前采样值为锚点（钳回 fit 视野内） */
function applyCurveZoom(): void {
  const base = fitCurveView();
  const f = curveZoom.value;
  const curve = doc.value?.curves.find((c) => c.prop === curveProp.value) ?? null;
  const pv = curve ? evaluateCurve(curve, time.value) : null;
  const anchor = Math.min(Math.max(pv ?? (base.lo + base.hi) / 2, base.lo), base.hi);
  curveView.value = {
    lo: anchor - (anchor - base.lo) * f,
    hi: anchor + (base.hi - anchor) * f,
  };
}

function onCurveZoomInput(e: Event): void {
  curveZoom.value = parseFloat((e.target as HTMLInputElement).value) || 1;
  applyCurveZoom();
}

/** 曲线视图数值轴复位：恢复自动适配（时间轴窗口不动） */
function resetCurveView(): void {
  curveView.value = null;
  curveZoom.value = 1;
}

/** 拖拽期间的数值窗快照（冻结自动适配）：防止被拖帧/切线的值变化实时重映射
 *  整条曲线导致漂移抖动；松手恢复。手动缩放（curveView）优先于快照 */
let curveViewFreeze: { lo: number; hi: number } | null = null;
function freezeCurveView(): void {
  if (curveView.value) return; // 已有手动数值窗，本就不变，无需快照
  const g = curveGeom.value;
  curveViewFreeze = { lo: g.lo, hi: g.hi };
}

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
  // 数值窗：手动缩放 > 拖拽冻结快照 > 自动适配；时间窗 = 共享时间窗（与 dope 同步）
  const vview = curveView.value ?? (curveDrag && curveViewFreeze ? curveViewFreeze : fitCurveView());
  const win = tWindow.value;
  const t0 = win.t0;
  const t1 = Math.max(win.t1, win.t0 + 1e-3);
  const lo = vview.lo;
  const hi = Math.max(vview.hi, vview.lo + 1e-6);
  const xOf = (t: number) => ((t - t0) / (t1 - t0)) * (w - pad * 2) + pad;
  const yOf = (v: number) => h - pad - ((v - lo) / (hi - lo)) * (h - pad * 2);
  const vOf = (y: number) => lo + ((h - pad - y) / Math.max(1, h - pad * 2)) * (hi - lo);
  // xOf 的逆映射（点击/拖拽换算 t；与绘制同套几何，不能用全宽的 xToT）；
  // 钳制到「可视窗口 ∩ 剪辑范围」（插帧/拖帧不会把点放到视野外丢失）
  const tOf = (x: number) =>
    d
      ? Math.max(
          Math.max(0, t0),
          Math.min(Math.min(d.duration, t1), ((x - pad) / Math.max(1, w - pad * 2)) * (t1 - t0) + t0),
        )
      : 0;
  // —— 选中/手动态的 smooth 帧生成切线手柄 ——
  // 注意：手柄纵向占位【不】进值域——否则选中任一帧都会重映射 lo/hi，
  // 其它关键帧与曲线整体「跳位」（编辑态面板偏移抖动）；超出绘图区的手柄
  // 被 svg 裁剪，拖大斜率时自然出界即可。
  const sel = selected.value;
  const selKey =
    sel && sel.prop === curveProp.value
      ? (keys.find((k) => Math.abs(k.t - sel.t) <= 1e-4) ?? null)
      : null;
  const wantHandles = keys.filter(
    (k) => k.i === "smooth" && (!isAutoTangent(k) || k === selKey),
  );
  const handles: TangentHandle[] = [];
  for (const k of wantHandles) {
    const i = keys.indexOf(k);
    const span = Math.max(0.05, d ? d.duration / 12 : 0.25);
    for (const side of ["ti", "to"] as const) {
      const slope = keySlope(keys, i, side);
      const sgn = side === "to" ? 1 : -1;
      handles.push({
        index: i,
        side,
        x: xOf(k.t + sgn * span),
        y: yOf(k.v + slope * sgn * span),
        manual: (side === "ti" ? k.ti : k.to) !== undefined,
        ghost: k.tm === true && side === (sgn > 0 ? "ti" : "to"),
      });
    }
  }
  // —— 曲线折线：按段类型精确绘制（钳到可视窗口，窗口外延长线 = 钳端点值）——
  const pts: string[] = [];
  if (keys.length && curve && d) {
    const push = (t: number, v: number): void => {
      pts.push(`${xOf(t).toFixed(1)},${yOf(v).toFixed(1)}`);
    };
    const wa = Math.max(t0, 0);
    const wb = Math.min(t1, d.duration);
    if (keys.length === 1) {
      push(wa, keys[0].v);
      push(wb, keys[0].v);
    } else {
      for (let i = 0; i + 1 < keys.length; i++) {
        const k1 = keys[i];
        const k2 = keys[i + 1];
        if (i === 0 && wa < k1.t) push(wa, k1.v); // 首帧前钳制水平段
        push(k1.t, k1.v);
        if (k1.i === "step") {
          // 阶跃：前值水平持续到下一帧时刻，再垂直跳变
          push(k2.t, k1.v);
          push(k2.t, k2.v);
          continue;
        }
        const span = Math.max(1e-6, k2.t - k1.t);
        if (k1.i === "smooth") {
          const m1 = keySlope(keys, i, "to") * span;
          const m2 = keySlope(keys, i + 1, "ti") * span;
          const N = 24;
          for (let s = 1; s <= N; s++) push(k1.t + (s / N) * span, hermite(k1, m1, k2, m2, s / N));
        } else {
          push(k2.t, k2.v);
        }
      }
      // 末帧 → 可视窗右缘的水平延长（求值钳末值，与播放行为一致）
      const lastK = keys[keys.length - 1];
      if (wb > lastK.t) push(wb, lastK.v);
    }
  }
  return {
    w,
    h,
    pad,
    t0,
    t1,
    lo,
    hi,
    xOf,
    yOf,
    vOf,
    tOf,
    keys,
    selKey,
    handles,
    polyline: pts.join(" "),
  };
});

type CurveDrag =
  | { kind: "key"; index: number; startX: number; startY: number; live: boolean }
  | { kind: "handle"; index: number; side: "ti" | "to"; startX: number; startY: number }
  | {
      kind: "pan";
      startT0: number;
      tSpan: number;
      startLo: number;
      vSpan: number;
      startX: number;
      startY: number;
    }
  | null;
let curveDrag: CurveDrag = null;
/** 曲线视图中键平移中（grab 光标态） */
const curvePanning = ref(false);

function onCurveDown(e: PointerEvent): void {
  const d = doc.value;
  const svg = curveSvgEl.value;
  if (!d || !svg) return;
  if (e.button === 2) return; // 右键交给 contextmenu（关键帧菜单）
  const r = svg.getBoundingClientRect();
  const g = curveGeom.value;
  const localX = e.clientX - r.left;
  const localY = e.clientY - r.top;
  if (e.button === 1) {
    // 中键 = 抓画布平移：水平拖共享时间窗、垂直拖数值窗（按下点保持跟随指针）
    e.preventDefault();
    const win = tWindow.value;
    curveDrag = {
      kind: "pan",
      startT0: win.t0,
      tSpan: win.t1 - win.t0,
      startLo: g.lo,
      vSpan: g.hi - g.lo,
      startX: localX,
      startY: localY,
    };
    curvePanning.value = true;
    svg.setPointerCapture?.(e.pointerId);
    return;
  }
  // 任何拖拽起点先冻结值域（松手恢复自动适配），编辑期间整图保持稳定
  freezeCurveView();
  // 手柄端点优先命中（自动态虚影不可拖：按下即固化两侧为手动再拖）
  const hitH = g.handles.find((hd) => Math.hypot(hd.x - localX, hd.y - localY) < 10);
  if (hitH) {
    const k = g.keys[hitH.index];
    if (!k) return;
    pickKey(curveProp.value, k.t);
    const idx = hitH.index;
    if (isAutoTangent(k)) ensureManualTangents(g.keys, idx);
    curveDrag = { kind: "handle", index: idx, side: hitH.side, startX: localX, startY: localY };
    svg.setPointerCapture?.(e.pointerId);
    return;
  }
  // 命中 = 到关键帧中心的二维距离（不只 x；否则相邻 t 不同 v 的点选不中）
  const hit = g.keys.find(
    (k) => Math.hypot(g.xOf(k.t) - localX, g.yOf(k.v) - localY) < 9,
  );
  if (hit) {
    pickKey(curveProp.value, hit.t);
    // live=false：先按点击处理，移出死区才转拖拽（防止点选时的抖动改值）
    curveDrag = { kind: "key", index: g.keys.indexOf(hit), startX: localX, startY: localY, live: false };
  } else {
    const t = snapT(g.tOf(localX), d.duration, snapEnabled.value && !e.altKey);
    const v = g.vOf(localY);
    const curve = curveOf(d, curveProp.value);
    upsertKey(curve, t, v);
    pickKey(curveProp.value, t);
    curveDrag = {
      kind: "key",
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
  if (dragNow.kind === "pan") {
    // 抓画布：按下瞬间画布下的 (t, v) 必须始终跟在指针下
    const plotW = Math.max(1, g.w - g.pad * 2);
    const plotH = Math.max(1, g.h - g.pad * 2);
    const tHold = dragNow.startT0 + ((dragNow.startX - g.pad) / plotW) * dragNow.tSpan;
    applyT0(tHold - ((localX - g.pad) / plotW) * dragNow.tSpan, zoom.value);
    const vHold = dragNow.startLo + ((g.h - g.pad - dragNow.startY) / plotH) * dragNow.vSpan;
    const lo = vHold - ((g.h - g.pad - localY) / plotH) * dragNow.vSpan;
    curveView.value = { lo, hi: lo + dragNow.vSpan };
    return;
  }
  const curve = d.curves.find((c) => c.prop === curveProp.value);
  const key = curve?.keys[dragNow.index];
  if (!curve || !key) return;
  if (dragNow.kind === "handle") {
    // 斜率 = 过关键帧与指针点的割线（时间差 < 20ms 不更新，防端点处爆斜率）
    const dt = (dragNow.side === "to" ? 1 : -1) * (g.tOf(localX) - key.t);
    if (dt < 0.02) return;
    const slope = clampSlope((g.vOf(localY) - key.v) / dt);
    key[dragNow.side] = slope;
    if (key.tm) key[dragNow.side === "to" ? "ti" : "to"] = slope;
    touch();
    return;
  }
  if (!dragNow.live) {
    if (Math.hypot(localX - dragNow.startX, localY - dragNow.startY) < 3) return;
    dragNow.live = true;
  }
  // Unity 式：自动态帧拖动先固化当前切线（值改后自动斜率会变，不固化会跳变）
  if (isAutoTangent(key)) ensureManualTangents(curve.keys, dragNow.index);
  key.t = snapT(g.tOf(localX), d.duration, snapEnabled.value && !e.altKey);
  // 数值钳回可视窗：缩放后拖到底/顶不会把关键帧「拖出视野失联」
  key.v = Math.min(Math.max(g.vOf(localY), g.lo), g.hi);
  curve.keys.sort((a, b) => a.t - b.t);
  dragNow.index = curve.keys.indexOf(key);
  selected.value = { prop: curveProp.value, t: key.t };
  touch();
}

function onCurveUp(): void {
  curvePanning.value = false;
  if (curveDrag?.kind === "pan" && curveView.value) {
    // 平移未改动数值窗（或被钳回原处）→ 清掉手动值窗恢复自动适配
    const fit = fitCurveView();
    if (Math.abs(curveView.value.lo - fit.lo) < 1e-9 && Math.abs(curveView.value.hi - fit.hi) < 1e-9) {
      curveView.value = null;
      curveZoom.value = 1;
    }
  }
  curveDrag = null;
  curveViewFreeze = null;
}

// 切换查看通道：丢弃手动缩放窗口（回到新通道的自动适配）；编辑中不重置
watch(curveProp, () => {
  if (!curveDrag) {
    curveView.value = null;
    curveZoom.value = 1;
  }
});

/** 滚轮缩放曲线视图：默认缩放时间轴（以指针时刻为中心，滚上 = 放大）；
 *  Shift+滚轮缩放数值轴（以指针值为中心）；Ctrl+滚轮平移时间轴。
 *  时间窗限幅 [1% 时长, 1.4×时长]（可越过 0/时长看钳制延长段），
 *  窗口拉回全览时复位为自动适配。 */
/** 曲线视图滚轮：与 dope 完全同一套方案——滚轮缩放共享时间窗（指针时刻不动）、
 *  Ctrl+滚轮平移、Shift+滚轮不拦截（统一方案）；数值轴不设鼠标滚轮操作，
 *  用中键纵向拖拽平移或工具条「值×」滑条调整。 */
function onCurveWheel(e: WheelEvent): void {
  const d = doc.value;
  const svg = curveSvgEl.value;
  if (!d || !svg) return;
  if (e.shiftKey && !e.ctrlKey) return; // 与 dope 一致：Shift 滚轮不拦截
  e.preventDefault();
  const r = svg.getBoundingClientRect();
  const frac = (e.clientX - r.left - 16) / Math.max(1, r.width - 32);
  timelineWheel(e, Math.min(Math.max(frac, 0), 1));
}

/** 曲线视图右键：命中帧弹出关键帧菜单（阻止默认浏览器菜单） */
function onCurveContextMenu(e: MouseEvent): void {
  e.preventDefault();
  const svg = curveSvgEl.value;
  if (!svg) return;
  const r = svg.getBoundingClientRect();
  const g = curveGeom.value;
  const hit = g.keys.find(
    (k) => Math.hypot(g.xOf(k.t) - (e.clientX - r.left), g.yOf(k.v) - (e.clientY - r.top)) < 9,
  );
  if (hit) onKeyMenu(e, curveProp.value, hit.t);
}

// ---------------------------------------------------------------------------
// 关键帧右键菜单（曲线视图 + dope 轨道共用）：插值 / 贝塞尔切线 / 删除
// ---------------------------------------------------------------------------
function keyAt(prop: AnimProp, t: number): AnimKey | null {
  return doc.value?.curves.find((c) => c.prop === prop)?.keys.find((k) => Math.abs(k.t - t) <= 1e-4) ?? null;
}

/** 设为平滑：自动态保持自动；从线性/阶跃转入时固化邻域自动切线 */
function setSmooth(prop: AnimProp, t: number): void {
  const curve = doc.value?.curves.find((c) => c.prop === prop);
  if (!curve) return;
  const i = curve.keys.findIndex((k) => Math.abs(k.t - t) <= 1e-4);
  const k = curve.keys[i];
  if (!k || k.i === "smooth") return;
  ensureManualTangents(curve.keys, i);
  k.i = "smooth";
  touch();
}

function setInterp(prop: AnimProp, t: number, i: AnimKeyInterp): void {
  const k = keyAt(prop, t);
  if (!k) return;
  if (i === "smooth") {
    setSmooth(prop, t);
    return;
  }
  k.i = i;
  clearTangents(k); // 线性/阶跃不使用切线：清除避免残留
  touch();
}

function onKeyMenu(e: MouseEvent, prop: AnimProp, t: number): void {
  const k = keyAt(prop, t);
  if (!k) return;
  pickKey(prop, t);
  const auto = isAutoTangent(k);
  const items: CtxMenuItem[] = [
    {
      label: "平滑（自动切线）",
      disabled: k.i === "smooth" && auto,
      onClick: () => {
        k.i = "smooth";
        clearTangents(k);
        touch();
      },
    },
    {
      label: "线性",
      disabled: k.i === "linear",
      onClick: () => setInterp(prop, t, "linear"),
    },
    {
      label: "阶跃",
      disabled: k.i === "step",
      onClick: () => setInterp(prop, t, "step"),
    },
    menuSeparator(),
    {
      label: "切线对称（联动）",
      disabled: auto,
      onClick: () => {
        k.tm = true;
        if (k.to !== undefined && k.ti === undefined) k.ti = k.to;
        if (k.ti !== undefined && k.to === undefined) k.to = k.ti;
        touch();
      },
    },
    {
      label: "切线断开（独立）",
      disabled: auto || k.tm !== true,
      onClick: () => {
        k.tm = false;
        touch();
      },
    },
    {
      label: "切线压平（水平）",
      disabled: k.ti === 0 && k.to === 0,
      onClick: () => {
        k.ti = 0;
        k.to = 0;
        k.tm = true;
        touch();
      },
    },
    menuSeparator(),
    {
      label: "删除关键帧",
      danger: true,
      onClick: () => deleteSelected(),
    },
  ];
  openContextMenu(e, items);
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
        <template v-if="viewMode === 'curve'">
          <span class="anim-sep"></span>
          <label class="zoom-ctl" title="曲线数值轴缩放（1 = 自动适配全曲线；调小 = 放大查看）。鼠标方案与帧动画统一：滚轮缩放时间轴、Ctrl 滚轮平移、中键拖拽平移（纵向拖动可平移数值轴）">
            <input type="range" min="0.2" max="4" step="0.1" :value="curveZoom" @input="onCurveZoomInput" />
            <span class="mono">值×{{ curveZoom.toFixed(1) }}</span>
          </label>
          <button class="anim-btn" :disabled="!curveView" title="复位数值轴（恢复自动适配全曲线；时间轴用底部滑条/滚轮）" @click="resetCurveView">适配</button>
        </template>
      </template>
    </div>

    <!-- 未选择剪辑 -->
    <div v-if="!doc" class="anim-empty">
      在上方选择 .anim 剪辑；没有可在资产面板右键「新建动画」，或给节点添加「动画剪辑」组件后从组件卡打开。
    </div>

    <template v-else>
      <div class="anim-body">
        <!-- 左列：层级轨道树滚动区（与右列双向同步滚动）+ 底部固定添加属性按钮 -->
        <div class="anim-names">
          <div class="names-scroll" ref="namesEl" @scroll="onNamesScroll()">
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
          </div>
          <button class="add-prop-btn" title="为剪辑添加可动画属性（按选中节点能力提供）" @click.stop="onAddPropertyMenu($event)">＋ 添加属性</button>
        </div>

        <!-- 右侧视图区：帧动画轨道 / 曲线编辑（下拉切换，二选一显示；共享时间窗缩放） -->
        <div class="anim-lanes" :class="{ panning: lanePanning }" ref="laneEl" @wheel="onLaneWheel($event)" @scroll="onLanesScroll()">
          <template v-if="viewMode === 'dope'">
            <div class="lane-wrap" :style="{ width: timelineWidth + 'px' }" @pointerdown="onWrapPointerDown($event)">
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
                  :title="`${k.t.toFixed(2)}s = ${k.v.toFixed(2)}（${k.i === 'linear' ? '线性' : k.i === 'step' ? '阶跃' : '平滑'}）；拖拽改时间，右键菜单`"
                  @pointerdown.stop="beginKeyDrag($event, row.prop, i)"
                  @contextmenu.stop.prevent="onKeyMenu($event, row.prop, k.t)"
                ></button>
                <span class="playhead thin" :style="{ left: tToX(time, doc.duration) + 'px' }"></span>
              </div>
            </template>
            <div v-if="tracks.length === 0" class="hint lane-empty">
              尚未添加属性：「＋ 添加属性」
            </div>
            </div>
          </template>
          <template v-else>
            <div v-if="tracks.length === 0" class="hint lane-empty">
              尚未添加属性：「＋ 添加属性」
            </div>
            <div v-else-if="!curveProp" class="hint lane-empty">点击左侧通道名显示其曲线</div>
            <template v-else>
              <div class="curve-title mono">{{ pathLabel(curveProp) }}</div>
              <svg
                ref="curveSvgEl"
                class="anim-curve"
                :class="{ panning: curvePanning }"
                :viewBox="`0 0 ${curveGeom.w} ${curveGeom.h}`"
                @pointerdown="onCurveDown"
                @pointermove="onCurveMove"
                @pointerup="onCurveUp"
                @pointercancel="onCurveUp"
                @contextmenu="onCurveContextMenu($event)"
                @wheel.prevent="onCurveWheel($event)"
              >
                <line
                  v-for="(tk, gi) in curveGridTicks"
                  :key="gi"
                  class="c-grid"
                  :class="{ minor: !rulerTicks.includes(tk) }"
                  :x1="curveGeom.xOf(tk)"
                  :y1="curveGeom.pad"
                  :x2="curveGeom.xOf(tk)"
                  :y2="curveGeom.h - curveGeom.pad"
                />
                <text
                  v-for="(tk, gi) in rulerTicks"
                  :key="'g' + gi"
                  class="c-gridlab mono"
                  :x="curveGeom.xOf(tk) + 3"
                  :y="curveGeom.pad - 4"
                >{{ tickLabel(tk) }}</text>
                <line class="c-playhead" :x1="curveGeom.xOf(time)" :y1="0" :x2="curveGeom.xOf(time)" :y2="curveGeom.h" />
                <line class="c-axis" :x1="curveGeom.pad" :y1="curveGeom.h - curveGeom.pad" :x2="curveGeom.w - curveGeom.pad" :y2="curveGeom.h - curveGeom.pad" />
                <line class="c-axis" :x1="curveGeom.pad" :y1="curveGeom.pad" :x2="curveGeom.pad" :y2="curveGeom.h - curveGeom.pad" />
                <polyline class="c-line" :points="curveGeom.polyline" />
                <!-- 切线手柄（杆 + 端点）：自动态虚影提示，手动态实心可拖 -->
                <template v-for="(hd, hi) in curveGeom.handles" :key="'h' + hi">
                  <line
                    class="c-handle"
                    :class="{ auto: !hd.manual, ghost: hd.ghost }"
                    :x1="curveGeom.xOf(curveGeom.keys[hd.index].t)"
                    :y1="curveGeom.yOf(curveGeom.keys[hd.index].v)"
                    :x2="hd.x"
                    :y2="hd.y"
                  />
                  <circle
                    class="c-handle-end"
                    :class="{ auto: !hd.manual, ghost: hd.ghost }"
                    :cx="hd.x"
                    :cy="hd.y"
                    r="4"
                  />
                </template>
                <rect
                  v-for="k in curveGeom.keys"
                  :key="k.t"
                  class="c-key"
                  :class="{
                    sel: selected?.prop === curveProp && Math.abs(selected.t - k.t) <= 1e-4,
                    manual: !isAutoTangent(k),
                    sym: k.tm === true,
                  }"
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
            title="选中关键帧的插值方式（自动 = 平滑 + Catmull-Rom 自动切线）"
            @change="onInterpChange($event)"
          >
            <option value="" disabled>（未选中关键帧）</option>
            <option value="auto" :disabled="selectedInterp !== 'auto' && selectedInterp !== 'smooth'">
              平滑 · 自动切线
            </option>
            <option value="linear">线性</option>
            <option value="step">阶跃</option>
            <option value="smooth">平滑</option>
          </select>
          <button class="anim-btn danger" :disabled="!selected" title="删除选中的关键帧" @click="deleteSelected">删除 K</button>
          <span class="anim-hint">{{ viewHint }}</span>
          <label class="zoom-ctl" title="时间轴缩放（1× 铺满；帧动画与曲线视图共用同一时间窗，滚轮同样可缩放）">
            <input type="range" min="1" max="8" step="0.5" :value="zoom" @input="onZoomInput" />
            <span class="mono">×{{ zoom.toFixed(1) }}</span>
          </label>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped src="../../styles/components/anim-editor.scss"></style>
