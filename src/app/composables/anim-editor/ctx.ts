// ---------------------------------------------------------------------------
// 动画编辑器共享上下文：各子模块（clip/preview/playback/tracks/timeline/
// curve/selection）通过一个共享状态对象互相提供依赖，模块之间不互相 import，
// 由组合根 useAnimEditor 按构造顺序把模块实例注入上下文字段。
//
// 约定：字段在组合根构造时依次赋值，模块只消费「在自己之后构造完成」的
// 兄弟模块（构造顺序：clip → preview → playback → tracks → timeline →
// selection → curve → view）；为保持可读性，箭头字段只读、接口即契约。
// ---------------------------------------------------------------------------
import type { ComputedRef, Ref } from "vue";
import type * as THREE from "three";
import type { AssetEntry } from "../../../lib/api";
import type { Node } from "../../../framework/prototype/Node";
import type {
  AnimClipCurve,
  AnimKey,
  AnimKeyInterp,
  AnimationClipData,
  AnimProp,
} from "../../../framework/animation/clip";

/** 单条曲线选取（通道键 + 关键帧时刻） */
export interface KeySel {
  prop: AnimProp;
  t: number;
}

// —— 各模块实例接口（组合根把它们相互注入，供模块内闭包使用）——

export interface ClipApi {
  clipRel: Ref<string>;
  doc: Ref<AnimationClipData | null>;
  rev: Ref<number>;
  dirty: Ref<boolean>;
  saving: Ref<boolean>;
  touch: () => void;
  flushSave: () => void;
  loadClip: (rel: string) => Promise<void>;
  onPickClip: (e: Event) => void;
  clipOptions: ComputedRef<AssetEntry[]>;
}

export interface PreviewApi {
  targetNode: Ref<Node | null>;
  targetObj: Ref<THREE.Object3D | null>;
  applyChannels: (node: Node, obj: THREE.Object3D, values: Map<AnimProp, number>) => void;
  previewAt: (t: number) => void;
  restorePreview: () => void;
}

export interface PlaybackApi {
  time: Ref<number>;
  playing: Ref<boolean>;
  recording: Ref<boolean>;
  togglePlaying: () => void;
  toggleRecording: () => void;
  stopPreview: () => void;
}

export interface TracksApi {
  curveOf: (d: AnimationClipData, prop: AnimProp) => AnimClipCurve;
  onDurationChange: (v: number) => void;
  onLoopsChange: (e: Event) => void;
  onAddPropertyMenu: (e: MouseEvent) => void;
  addProperty: (prop: AnimProp) => void;
  removeChannel: (prop: AnimProp) => void;
  keyChannel: (prop: AnimProp) => void;
  keyAll: () => void;
  fullPathOf: (prop: AnimProp) => string;
  pathLabel: (prop: AnimProp) => string;
  keysOf: (prop: AnimProp) => readonly AnimKey[];
  keyCount: (prop: AnimProp) => number;
  /** `tracks`/`trackRows`/`keyCount` 内部都重新读取 rev；模板直接解包 */
  tracks: ComputedRef<readonly AnimClipCurve[]>;
  trackRows: ComputedRef<readonly TrackRow[]>;
  collapsedGroups: Ref<ReadonlySet<string>>;
  isGroupCollapsed: (pathKey: string) => boolean;
  toggleGroup: (pathKey: string) => void;
}

/** 轨道层级树的一行（group = 可折叠组；leaf = 通道） */
export interface TrackRow {
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

export interface TimelineApi {
  laneEl: Ref<HTMLElement | null>;
  namesEl: Ref<HTMLElement | null>;
  laneWidth: Ref<number>;
  laneHeight: Ref<number>;
  zoom: Ref<number>;
  tlT0: Ref<number>;
  tWindow: Ref<{ t0: number; t1: number }>;
  /** dope 内容层总宽（= 全时长 × 倍率：zoom=1 恰好铺满） */
  timelineWidth: Ref<number>;
  applyT0: (t0: number, z: number) => void;
  setTWindow: (zNew: number, anchorFrac: number, anchorT: number) => void;
  timelineWheel: (e: WheelEvent, frac: number) => void;
  onLaneWheel: (e: WheelEvent) => void;
  onZoomInput: (e: Event) => void;
  onWrapPointerDown: (e: PointerEvent) => void;
  onLanesScroll: () => void;
  onNamesScroll: () => void;
  beginLanePan: (e: PointerEvent) => void;
  lanePanning: Ref<boolean>;
  tToX: (t: number, duration: number) => number;
  xToT: (x: number, duration: number) => number;
  rulerStep: Ref<number>;
  tickDecimals: Ref<number>;
  tickLabel: (t: number) => string;
  rulerTicks: Ref<readonly number[]>;
  tlZoomed: Ref<boolean>;
  curveGridTicks: Ref<readonly number[]>;
  snapEnabled: Ref<boolean>;
  snapT: (t: number, duration: number, enabled: boolean) => number;
  beginScrub: (e: PointerEvent) => void;
  beginKeyDrag: (e: PointerEvent, prop: AnimProp, index: number) => void;
  onRulerPointerMove: (e: PointerEvent) => void;
  onLanePointerMove: (e: PointerEvent) => void;
  onLanePointerUp: () => void;
}

export interface SelectionApi {
  selected: Ref<KeySel | null>;
  pickKey: (prop: AnimProp, t: number) => void;
  deleteSelected: () => void;
  selectedInterp: Ref<AnimKeyInterp | "auto" | "">;
  onInterpChange: (e: Event) => void;
  keyAt: (prop: AnimProp, t: number) => AnimKey | null;
  setSmooth: (prop: AnimProp, t: number) => void;
  /** 直接设插值（smooth 走 setSmooth；linear/step 清除切线） */
  setInterp: (prop: AnimProp, t: number, i: AnimKeyInterp) => void;
  onKeyMenu: (e: MouseEvent, prop: AnimProp, t: number) => void;
}

export interface CurveApi {
  curveProp: Ref<AnimProp>;
  /** 曲线 SVG 元素（模板 ref 绑定；指针交互换算坐标用） */
  curveSvgEl: Ref<SVGSVGElement | null>;
  curveView: Ref<{ lo: number; hi: number } | null>;
  curveZoom: Ref<number>;
  curveGeom: ComputedRef<CurveGeom>;
  curvePanning: Ref<boolean>;
  /** 数值轴复位为自动适配（工具条「适配」按钮；时间轴窗口不动） */
  resetCurveView: () => void;
  /** 切剪辑的整体复位（含拖拽冻结快照） */
  reset: () => void;
  onCurveZoomInput: (e: Event) => void;
  onCurveDown: (e: PointerEvent) => void;
  onCurveMove: (e: PointerEvent) => void;
  onCurveUp: () => void;
  onCurveWheel: (e: WheelEvent) => void;
  onCurveContextMenu: (e: MouseEvent) => void;
  isAutoTangent: (k: AnimKey) => boolean;
}

/** 曲线视图几何（SVG 绘制 / 命中换算统一从它取值） */
export interface CurveGeom {
  w: number;
  h: number;
  pad: number;
  t0: number;
  t1: number;
  lo: number;
  hi: number;
  xOf: (t: number) => number;
  yOf: (v: number) => number;
  vOf: (y: number) => number;
  tOf: (x: number) => number;
  keys: AnimKey[];
  selKey: AnimKey | null;
  handles: readonly TangentHandle[];
  polyline: string;
}

export interface TangentHandle {
  index: number;
  side: "ti" | "to";
  /** 权重基准段跨（相邻关键帧段，秒）：拖拽时 权重=|Δt|/base（绘制同步携带） */
  base: number;
  x: number;
  y: number;
  /** 手动态 = 实心可拖；自动态 = 虚影提示 */
  manual: boolean;
  /** 联动（tm）的非选中侧：弱化显示 */
  ghost: boolean;
}

export interface ViewApi {
  viewMode: Ref<"dope" | "curve">;
  onViewModeChange: (e: Event) => void;
  viewHint: Ref<string>;
}

/** 动画编辑器全量实例（模板只消费这一份） */
export interface AnimEditorCtx {
  clip: ClipApi;
  preview: PreviewApi;
  playback: PlaybackApi;
  tracks: TracksApi;
  timeline: TimelineApi;
  selection: SelectionApi;
  curve: CurveApi;
  view: ViewApi;
}