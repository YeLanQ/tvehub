<script setup lang="ts">
/**
 * SVG 画布（绘画窗口中央区域）：
 * - 视口：滚轮以光标为锚缩放，空格/中键拖拽平移，挂载时取景画板（工具条可再「适应」）；
 * - 渲染：图层 <g>（可见性/锁定/不透明度）+ 元素（矩形/椭圆/直线/铅笔/钢笔/文本）；
 *   动画 <style> 挂在 svg 根内（textContent 由 store.animCss 驱动；播放/暂停经根 class）；
 * - 交互：选择工具下点击选中、拖拽移动（transact/settle 折叠历史），矩形/椭圆/
 *   直线拖拽创建（点按落默认尺寸），铅笔自由绘制，钢笔逐点（Enter 结束 / 双击闭合 /
 *   Esc 取消），文本点击落点创建；矩形/椭圆四角控制点缩放，直线端点拖拽。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { getWhiteboardStore } from "../whiteboardStore";
import { whiteboardLayout } from "../layout";
import { HANDLE_CURSOR } from "../tool-icons";
import { toolCursorCss } from "../tool-icons";
import {
  buildPathD,
  buildTextInner,
  DEFAULT_FONT,
  deletePathAnchor,
  elBBox,
  genId,
  insertPathAnchor,
  nearestPathSegment,
  newStyle,
  roundElCoords,
  type SvgEl,
  type SvgElKind,
  type SvgPt,
} from "../svg-doc";

/** 钢笔节点：锚点 + 可选对称控制柄（相对锚点偏移） */
interface PenNode {
  p: SvgPt;
  ci?: SvgPt;
  co?: SvgPt;
}

const store = getWhiteboardStore();

// ---------------------------------------------------------------------------
// 视口：world → screen = world * z + (view.x, view.y)；viewBox 跟随舞台 CSS 尺寸
// ---------------------------------------------------------------------------
const wrapRef = ref<HTMLDivElement | null>(null);
const size = reactive({ w: 1, h: 1 });
const view = reactive({ x: 0, y: 0, z: 1 });
let resizeObs: ResizeObserver | null = null;
let fitted = false;

const viewBoxAttr = computed(() => `0 0 ${size.w} ${size.h}`);
const viewTransform = computed(() => `translate(${view.x},${view.y}) scale(${view.z})`);
const zoomPct = computed(() => Math.round(view.z * 100));

const toSx = (wx: number): number => wx * view.z + view.x;
const toSy = (wy: number): number => wy * view.z + view.y;

function svgWorld(e: PointerEvent | WheelEvent): SvgPt {
  const rect = svgRef.value?.getBoundingClientRect();
  const sx = e.clientX - (rect?.left ?? 0);
  const sy = e.clientY - (rect?.top ?? 0);
  return { x: (sx - view.x) / view.z, y: (sy - view.y) / view.z };
}

function fitView(): void {
  const doc = store.state.doc;
  const z = Math.min(size.w / doc.w, size.h / doc.h) * 0.88;
  view.z = Math.min(20, Math.max(0.05, z || 1));
  view.x = (size.w - doc.w * view.z) / 2;
  view.y = (size.h - doc.h * view.z) / 2;
}

function resetZoom(): void {
  const rect = svgRef.value?.getBoundingClientRect();
  const cx = (rect?.width ?? 0) / 2;
  const cy = (rect?.height ?? 0) / 2;
  const wx = (cx - view.x) / view.z;
  const wy = (cy - view.y) / view.z;
  view.z = 1;
  view.x = cx - wx;
  view.y = cy - wy;
}

function onWheel(e: WheelEvent): void {
  e.preventDefault();
  const rect = svgRef.value?.getBoundingClientRect();
  const sx = e.clientX - (rect?.left ?? 0);
  const sy = e.clientY - (rect?.top ?? 0);
  const wx = (sx - view.x) / view.z;
  const wy = (sy - view.y) / view.z;
  const factor = Math.exp(-e.deltaY * 0.0015);
  view.z = Math.min(20, Math.max(0.05, view.z * factor));
  view.x = sx - wx * view.z;
  view.y = sy - wy * view.z;
}

// ---------------------------------------------------------------------------
// 渲染辅助
// ---------------------------------------------------------------------------
const svgRef = ref<SVGSVGElement | null>(null);

/** 动画 <style> 挂在 svg 根内（模板不允许 style 标签，onMounted 经 DOM API 注入，
 *  追加在所有 vnode 之后不参与 patch；textContent 更新不转义，CSS 字符安全） */
let styleNode: SVGStyleElement | null = null;

const layersWithEls = computed(() => {
  const doc = store.state.doc;
  return doc.layers
    .filter((l) => l.visible)
    .map((l) => ({ layer: l, els: doc.els.filter((e) => e.layerId === l.id) }));
});

const dashAttr = (el: SvgEl): string | undefined =>
  el.style.dash > 0 ? String(el.style.dash) : undefined;
const opAttr = (el: SvgEl): number | undefined =>
  el.style.opacity < 1 ? el.style.opacity : undefined;
/** 文本描边属性：无描边时不下发（免得 stroke-width 干扰字形）；有描边时垫在填充之下 */
function textStrokeAttrs(el: SvgEl): Record<string, string | number> {
  if (el.style.stroke === "none") return {};
  const attrs: Record<string, string | number> = {
    stroke: el.style.stroke,
    "stroke-width": el.style.strokeWidth,
    "paint-order": "stroke",
  };
  if (el.style.dash > 0) attrs["stroke-dasharray"] = el.style.dash;
  return attrs;
}
const ptsAttr = (pts: SvgPt[]): string =>
  pts.map((p) => `${Math.round(p.x * 100) / 100},${Math.round(p.y * 100) / 100}`).join(" ");

const cursorStyle = computed(() => {
  if (dragMode.value === "pan") return "grabbing";
  if (spaceHeld.value) return "grab";
  if (store.state.tool === "select") {
    // 句柄/锚点编辑拖拽中：句柄用蓝点光标，锚点用移动箭头
    if (dragMode.value === "pathEdit") return drag?.which ? HANDLE_CURSOR : "move";
    return "default";
  }
  // 绘制工具：光标切换为对应工具 SVG 图标（热点 = 落笔点）
  return toolCursorCss(store.state.tool);
});

// ---------------------------------------------------------------------------
// 拖拽状态机（非响应式；拖拽期间经 store.transact/settle 折叠为一条历史）
// ---------------------------------------------------------------------------
interface DragState {
  mode: "pan" | "move" | "resize" | "create" | "pen" | "penAnchor" | "penHandle" | "pathEdit";
  lastW: SvgPt;
  lastC: { x: number; y: number };
  handle?: string;
  anchor?: SvgPt;
  /** pen：正在拖出柄的节点下标；penAnchor/penHandle/pathEdit：锚点下标 */
  idx?: number;
  /** pathEdit/penHandle：正在调整的柄 */
  which?: "ci" | "co";
}
let drag: DragState | null = null;
/** 当前拖拽模式（响应式镜像，供 cursorStyle 读取） */
const dragMode = ref<DragState["mode"] | null>(null);

const draft = ref<SvgEl | null>(null);
const penNodes = ref<PenNode[]>([]);
/** 当前强调（新建/拖拽中）的待绘制节点下标 */
const activePenIdx = ref<number | null>(null);
const spaceHeld = ref(false);
const cursorW = reactive({ x: 0, y: 0 });

/** 活动图层可创建（未选活动图层时回退最后一层；锁定时禁止） */
function createTargetOk(): boolean {
  const id = activeLayerId();
  const layer = store.state.doc.layers.find((l) => l.id === id);
  if (!layer || layer.locked) {
    store.showNotice(layer?.locked ? "活动图层已锁定，请先解锁" : "请先选择一个图层");
    return false;
  }
  return true;
}

function activeLayerId(): string {
  return store.state.activeLayerId ?? store.state.doc.layers[store.state.doc.layers.length - 1]?.id ?? "";
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

function makeDraft(kind: SvgElKind, at: SvgPt): SvgEl {
  const style = newStyle(kind);
  // 线条工具（直线/铅笔/钢笔）粗细跟随浮动工具栏上方的滑动条
  style.strokeWidth = Math.max(0.5, whiteboardLayout.toolWidth);
  return {
    id: genId(),
    kind,
    layerId: activeLayerId(),
    x: r3(at.x), y: r3(at.y), w: 0, h: 0,
    x1: r3(at.x), y1: r3(at.y), x2: r3(at.x), y2: r3(at.y),
    points: [{ x: r3(at.x), y: r3(at.y) }],
    closed: false,
    text: "",
    style,
    anims: [],
  };
}

function capture(e: PointerEvent): void {
  try {
    svgRef.value?.setPointerCapture(e.pointerId);
  } catch {
    /* 指针已释放 */
  }
}

/** 画板空白处按下：平移 / 取消选中 / 启动创建 / 钢笔加点 */
function onBgDown(e: PointerEvent): void {
  // 平移：空格 + 左键 或 中键
  if (spaceHeld.value || e.button === 1) {
    e.preventDefault();
    const w = svgWorld(e);
    dragMode.value = "pan";
  drag = { mode: "pan", lastW: w, lastC: { x: e.clientX, y: e.clientY } };
    capture(e);
    return;
  }
  if (e.button !== 0) return;
  const tool = store.state.tool;
  if (tool === "select") {
    store.selectEl(null);
    return;
  }
  if (tool === "pen") {
    penDown(e);
    return;
  }
  if (!createTargetOk()) return;
  const w = svgWorld(e);
  if (tool === "text") {
    const el = makeDraft("text", w);
    el.text = "文本";
    store.addEl(el);
    store.setTool("select");
    return;
  }
  draft.value = makeDraft(tool, w);
  dragMode.value = "create";
  drag = { mode: "create", lastW: w, lastC: { x: e.clientX, y: e.clientY } };
  capture(e);
}

/** 钢笔：按下落锚点（近距去重），随后拖拽拉出对称手柄 → 曲线点 */
/** 命中待绘制锚点/柄（屏幕 6px 半径；柄优先） */
function hitPending(w: SvgPt): { kind: "anchor" | "ci" | "co"; idx: number } | null {
  const hitR = 6 / view.z;
  for (let i = penNodes.value.length - 1; i >= 0; i--) {
    const n = penNodes.value[i];
    if (n.co && Math.hypot(n.p.x + n.co.x - w.x, n.p.y + n.co.y - w.y) < hitR) {
      return { kind: "co", idx: i };
    }
    if (n.ci && Math.hypot(n.p.x + n.ci.x - w.x, n.p.y + n.ci.y - w.y) < hitR) {
      return { kind: "ci", idx: i };
    }
  }
  for (let i = penNodes.value.length - 1; i >= 0; i--) {
    const n = penNodes.value[i];
    if (Math.hypot(n.p.x - w.x, n.p.y - w.y) < hitR) return { kind: "anchor", idx: i };
  }
  return null;
}

function penDown(e: PointerEvent): void {
  const w = svgWorld(e);
  // 已有锚点/柄命中 → 编辑而非新建
  const hit = hitPending(w);
  if (hit) {
    activePenIdx.value = hit.idx;
    dragMode.value = hit.kind === "anchor" ? "penAnchor" : "penHandle";
    drag = {
      mode: hit.kind === "anchor" ? "penAnchor" : "penHandle",
      idx: hit.idx,
      which: hit.kind === "anchor" ? undefined : hit.kind,
      lastW: w,
      lastC: { x: e.clientX, y: e.clientY },
    };
    capture(e);
    return;
  }
  const last = penNodes.value[penNodes.value.length - 1];
  if (last && Math.hypot(last.p.x - w.x, last.p.y - w.y) * view.z < 4) return;
  penNodes.value = [...penNodes.value, { p: { x: r3(w.x), y: r3(w.y) } }];
  activePenIdx.value = penNodes.value.length - 1;
  dragMode.value = "pen";
  drag = {
    mode: "pen",
    idx: penNodes.value.length - 1,
    lastW: w,
    lastC: { x: e.clientX, y: e.clientY },
  };
  capture(e);
}

function penFinish(closed: boolean): void {
  const nodes = penNodes.value;
  penNodes.value = [];
  activePenIdx.value = null;
  if (nodes.length < 2) return;
  if (!createTargetOk()) return;
  const el = makeDraft("path", nodes[0].p);
  el.points = nodes.map((n) => n.p);
  if (nodes.some((n) => n.ci || n.co)) {
    el.curve = nodes.map((n) => ({ ci: n.ci, co: n.co }));
  }
  el.closed = closed;
  el.style.fill = closed ? newStyle("path").fill : "none";
  store.addEl(el);
}

function penCancel(): void {
  penNodes.value = [];
  activePenIdx.value = null;
}

/** 钢笔预览路径（开放曲线） */
const penPreviewD = computed(() => {
  if (penNodes.value.length < 2) return "";
  return buildPathD({
    points: penNodes.value.map((n) => n.p),
    curve: penNodes.value.some((n) => n.ci || n.co)
      ? penNodes.value.map((n) => ({ ci: n.ci, co: n.co }))
      : undefined,
    closed: false,
  });
});

defineExpose({ fitView, penFinish, penCancel, deleteActiveAnchor });

/** 元素按下：选择 → 选中+移动；绘制工具 → 视同空白处（创建/钢笔）；空格/中键 → 平移 */
function onElDown(el: SvgEl, e: PointerEvent): void {
  if (spaceHeld.value || e.button === 1) {
    onBgDown(e);
    return;
  }
  if (e.button !== 0) return;
  const tool = store.state.tool;
  if (tool === "select") {
    const layer = store.state.doc.layers.find((l) => l.id === el.layerId);
    if (layer?.locked) return; // 穿透：视为空白（取消选中）
    e.stopPropagation();
    store.selectEl(el.id);
    const w = svgWorld(e);
    dragMode.value = "move";
  drag = { mode: "move", lastW: w, lastC: { x: e.clientX, y: e.clientY } };
    capture(e);
    return;
  }
  e.stopPropagation();
  if (tool === "pen") {
    penDown(e);
    return;
  }
  onBgDown(e);
}

/** 控制点按下：矩形/椭圆四角缩放；直线端点拖拽 */
function onHandleDown(handle: string, e: PointerEvent): void {
  const el = store.selectedEl();
  if (!el || e.button !== 0) return;
  e.stopPropagation();
  const w = svgWorld(e);
  dragMode.value = "resize";
  drag = { mode: "resize", lastW: w, lastC: { x: e.clientX, y: e.clientY }, handle };
  if (el.kind === "rect" || el.kind === "ellipse") {
    drag.anchor =
      handle === "nw" ? { x: el.x + el.w, y: el.y + el.h }
      : handle === "ne" ? { x: el.x, y: el.y + el.h }
      : handle === "sw" ? { x: el.x + el.w, y: el.y }
      : { x: el.x, y: el.y };
  }
  capture(e);
}

function onPointerMove(e: PointerEvent): void {
  const w = svgWorld(e);
  cursorW.x = Math.round(w.x);
  cursorW.y = Math.round(w.y);
  if (!drag) return;
  switch (drag.mode) {
    case "pan": {
      view.x += e.clientX - drag.lastC.x;
      view.y += e.clientY - drag.lastC.y;
      drag.lastC = { x: e.clientX, y: e.clientY };
      break;
    }
    case "move": {
      const dx = w.x - drag.lastW.x;
      const dy = w.y - drag.lastW.y;
      if (dx === 0 && dy === 0) return;
      store.moveSelectedBy(dx, dy);
      drag.lastW = w;
      break;
    }
    case "resize": {
      const el = store.selectedEl();
      if (!el) return;
      const handle = drag.handle;
      const anchor = drag.anchor;
      store.transact(() => {
        if (el.kind === "line") {
          if (handle === "p1") {
            el.x1 = w.x;
            el.y1 = w.y;
          } else {
            el.x2 = w.x;
            el.y2 = w.y;
          }
        } else if (anchor) {
          el.x = Math.min(anchor.x, w.x);
          el.y = Math.min(anchor.y, w.y);
          el.w = Math.max(2, Math.abs(w.x - anchor.x));
          el.h = Math.max(2, Math.abs(w.y - anchor.y));
        }
        roundElCoords(el);
      });
      break;
    }
    case "create": {
      const d = draft.value;
      if (!d) return;
      const anchor = drag.lastW;
      const tool = store.state.tool;
      if (tool === "rect" || tool === "ellipse") {
        d.x = Math.min(anchor.x, w.x);
        d.y = Math.min(anchor.y, w.y);
        d.w = Math.abs(w.x - anchor.x);
        d.h = Math.abs(w.y - anchor.y);
      } else if (tool === "line") {
        d.x2 = w.x;
        d.y2 = w.y;
      } else if (tool === "pencil") {
        const last = d.points[d.points.length - 1];
        if (!last || Math.hypot(last.x - w.x, last.y - w.y) * view.z > 2) {
          d.points = [...d.points, w];
        }
      }
      if (tool !== "pencil") roundElCoords(d);
      break;
    }
    case "pen": {
      const node = drag.idx != null ? penNodes.value[drag.idx] : undefined;
      if (!node) return;
      const co = { x: w.x - node.p.x, y: w.y - node.p.y };
      if (Math.hypot(co.x, co.y) * view.z > 3) {
        node.co = co;
        node.ci = { x: -co.x, y: -co.y };
      }
      break;
    }
    case "penAnchor": {
      const node = drag.idx != null ? penNodes.value[drag.idx] : undefined;
      if (!node) return;
      node.p = { x: r3(w.x), y: r3(w.y) };
      break;
    }
    case "penHandle": {
      const node = drag.idx != null ? penNodes.value[drag.idx] : undefined;
      if (!node || !drag.which) return;
      node[drag.which] = { x: r3(w.x - node.p.x), y: r3(w.y - node.p.y) };
      break;
    }
    case "pathEdit": {
      const el = store.selectedEl();
      const idx = drag.idx;
      const which = drag.which;
      if (!el || el.kind !== "path" || idx == null) return;
      store.transact(() => {
        const anchor = el.points[idx];
        if (!anchor) return;
        if (!which) {
          // 移动锚点：柄为相对偏移，自动跟随
          anchor.x = r3(w.x);
          anchor.y = r3(w.y);
        } else {
          // 调整柄：柄偏移 = 指针世界坐标 - 锚点
          el.curve = el.curve ?? [];
          el.curve[idx] = el.curve[idx] ?? {};
          el.curve[idx][which] = { x: r3(w.x - anchor.x), y: r3(w.y - anchor.y) };
        }
      });
      break;
    }
  }
}

function onPointerUp(e: PointerEvent): void {
  const d = draft.value;
  if (drag?.mode === "create" && d) {
    const tool = store.state.tool;
    if (tool === "rect" || tool === "ellipse") {
      if (d.w < 2 && d.h < 2) {
        d.x -= 40;
        d.y -= 30;
        d.w = 80;
        d.h = 60;
      }
      draft.value = null;
      store.addEl(d);
      store.setTool("select");
    } else if (tool === "line") {
      if (Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < 3) {
        d.x2 = d.x1 + 100;
        d.y2 = d.y1;
      }
      draft.value = null;
      store.addEl(d);
      store.setTool("select");
    } else if (tool === "pencil") {
      if (d.points.length < 2) {
        d.points = [...d.points, { x: d.points[0].x + 1, y: d.points[0].y + 1 }];
      }
      draft.value = null;
      store.addEl(d);
      store.setTool("select");
    }
  } else if (drag?.mode === "pen") {
    const node = drag.idx != null ? penNodes.value[drag.idx] : undefined;
    if (node?.co && node.ci && Math.hypot(node.co.x, node.co.y) * view.z <= 3) {
      delete node.co;
      delete node.ci;
    }
  } else if (drag?.mode === "penAnchor" || drag?.mode === "penHandle") {
    // 待绘制节点，不入历史
  } else if (drag?.mode === "pathEdit") {
    store.settle("编辑路径");
  } else if (drag?.mode === "move") {
    store.settle("移动元素");
  } else if (drag?.mode === "resize") {
    store.settle("调整尺寸");
  }
  drag = null;
  dragMode.value = null;
  try {
    svgRef.value?.releasePointerCapture(e.pointerId);
  } catch {
    /* 未捕获该指针 */
  }
}

/** 文本元素的实测包围盒（getBBox，世界坐标）：估算公式对中文等字符偏差大 */
const textSelBox = ref<{ id: string; b: { x: number; y: number; w: number; h: number } } | null>(null);

watch(
  () => {
    const el = store.selectedEl();
    if (el?.kind !== "text") return null;
    return {
      id: el.id,
      x: el.x,
      y: el.y,
      text: el.text,
      fontSize: el.style.fontSize,
      align: el.style.textAlign,
      font: el.style.fontFamily,
      stroke: el.style.stroke,
      strokeWidth: el.style.strokeWidth,
    };
  },
  async (key) => {
    if (!key) {
      textSelBox.value = null;
      return;
    }
    await nextTick();
    const node = svgRef.value?.querySelector<SVGGraphicsElement>(`text[data-el="${key.id}"]`) ?? null;
    if (!node) {
      textSelBox.value = null;
      return;
    }
    // getBBox 不含描边：描边居中压在字形轮廓上，各向外扩半个线宽
    const pad = key.stroke !== "none" ? key.strokeWidth / 2 : 0;
    const b = node.getBBox();
    textSelBox.value = {
      id: key.id,
      b: { x: b.x - pad, y: b.y - pad, w: b.width + pad * 2, h: b.height + pad * 2 },
    };
  },
  { immediate: true },
);

// ---------------------------------------------------------------------------
// 选中框 / 控制点（屏幕空间，尺寸不随缩放）
// ---------------------------------------------------------------------------
const selBox = computed(() => {
  const el = store.selectedEl();
  if (!el) return null;
  if (el.kind === "line") {
    return {
      x: toSx(Math.min(el.x1, el.x2)) - 6,
      y: toSy(Math.min(el.y1, el.y2)) - 6,
      w: Math.abs(toSx(el.x2) - toSx(el.x1)) + 12,
      h: Math.abs(toSy(el.y2) - toSy(el.y1)) + 12,
    };
  }
  // 文本：优先用实测包围盒（渲染后测量，与字形一致）
  const b =
    el.kind === "text" && textSelBox.value?.id === el.id ? textSelBox.value.b : elBBox(el);
  return {
    x: toSx(b.x) - 4,
    y: toSy(b.y) - 4,
    w: b.w * view.z + 8,
    h: b.h * view.z + 8,
  };
});

interface HandlePt {
  id: string;
  x: number;
  y: number;
}

const selHandles = computed<HandlePt[]>(() => {
  const el = store.selectedEl();
  if (!el) return [];
  if (el.kind === "line") {
    return [
      { id: "p1", x: toSx(el.x1), y: toSy(el.y1) },
      { id: "p2", x: toSx(el.x2), y: toSy(el.y2) },
    ];
  }
  if (el.kind !== "rect" && el.kind !== "ellipse") return [];
  const b = elBBox(el);
  return [
    { id: "nw", x: toSx(b.x), y: toSy(b.y) },
    { id: "ne", x: toSx(b.x + b.w), y: toSy(b.y) },
    { id: "sw", x: toSx(b.x), y: toSy(b.y + b.h) },
    { id: "se", x: toSx(b.x + b.w), y: toSy(b.y + b.h) },
  ];
});

/** 当前强调（选中/拖拽中）的锚点下标；null = 无 */
const activeAnchorIdx = ref<number | null>(null);

/** 选中路径的锚点/柄编辑点（select 工具；屏幕坐标） */
interface PathEditPoint {
  i: number;
  which: "ci" | "co";
  x: number;
  y: number;
}

const pathEditAnchors = computed<HandlePt[]>(() => {
  const el = store.selectedEl();
  if (!el || el.kind !== "path" || store.state.tool !== "select") return [];
  return el.points.map((pt) => ({ id: String(el.points.indexOf(pt)), x: toSx(pt.x), y: toSy(pt.y) }));
});

const pathEditHandles = computed<PathEditPoint[]>(() => {
  const el = store.selectedEl();
  if (!el || el.kind !== "path" || store.state.tool !== "select") return [];
  const out: PathEditPoint[] = [];
  el.points.forEach((pt, i) => {
    const h = el.curve?.[i];
    if (h?.ci) out.push({ i, which: "ci", x: toSx(pt.x + h.ci.x), y: toSy(pt.y + h.ci.y) });
    if (h?.co) out.push({ i, which: "co", x: toSx(pt.x + h.co.x), y: toSy(pt.y + h.co.y) });
  });
  return out;
});

/** 柄线（锚点 → 柄端点） */
const pathEditHandleLines = computed(() => {
  const el = store.selectedEl();
  if (!el || el.kind !== "path" || store.state.tool !== "select") return [];
  const out: { x1: number; y1: number; x2: number; y2: number }[] = [];
  el.points.forEach((pt, i) => {
    const h = el.curve?.[i];
    if (h?.ci) out.push({ x1: toSx(pt.x), y1: toSy(pt.y), x2: toSx(pt.x + h.ci.x), y2: toSy(pt.y + h.ci.y) });
    if (h?.co) out.push({ x1: toSx(pt.x), y1: toSy(pt.y), x2: toSx(pt.x + h.co.x), y2: toSy(pt.y + h.co.y) });
  });
  return out;
});

/** 锚点按下：进入 pathEdit 拖拽（移动锚点） */
function onPathAnchorDown(i: number, e: PointerEvent): void {
  const el = store.selectedEl();
  if (!el || e.button !== 0) return;
  activeAnchorIdx.value = i;
  e.stopPropagation();
  const w = svgWorld(e);
  dragMode.value = "pathEdit";
    drag = { mode: "pathEdit", idx: i, lastW: w, lastC: { x: e.clientX, y: e.clientY } };
  capture(e);
}

/** 柄端点按下：进入 pathEdit 拖拽（调整柄） */
function onPathHandleDown(i: number, which: "ci" | "co", e: PointerEvent): void {
  const el = store.selectedEl();
  if (!el || e.button !== 0) return;
  activeAnchorIdx.value = i;
  e.stopPropagation();
  const w = svgWorld(e);
  dragMode.value = "pathEdit";
  drag = { mode: "pathEdit", idx: i, which, lastW: w, lastC: { x: e.clientX, y: e.clientY } };
  capture(e);
}

/**
 * 根节点双击：元素上的 dblclick 会因 setPointerCapture 重定向到根而失灵，
 * 统一在此处理——select 工具下双击选中路径的边缘（8px 内）插入锚点。
 */
function onRootDblClick(e: MouseEvent): void {
  if (store.state.tool === "pen") {
    penFinish(true);
    return;
  }
  if (store.state.tool !== "select") return;
  const el = store.selectedEl();
  if (!el || el.kind !== "path") return;
  const w = svgWorld(e as unknown as PointerEvent);
  const hit = nearestPathSegment(el, w);
  if (!hit || Math.hypot(hit.pos.x - w.x, hit.pos.y - w.y) * view.z > 8) return;
  let newIdx = -1;
  store.commit("添加锚点", () => {
    newIdx = insertPathAnchor(el, hit.seg, hit.t, hit.pos);
  });
  activeAnchorIdx.value = newIdx >= 0 ? newIdx : null;
}

/** 删除当前强调的锚点（Delete）；无可删锚点时返回 false（整体删除元素） */
function deleteActiveAnchor(): boolean {
  const el = store.selectedEl();
  if (!el || el.kind !== "path" || activeAnchorIdx.value == null) return false;
  const idx = activeAnchorIdx.value;
  if (idx < 0 || idx >= el.points.length || el.points.length <= 2) return false;
  store.commit("删除锚点", () => {
    deletePathAnchor(el, idx);
  });
  activeAnchorIdx.value = null;
  return true;
}

// ---------------------------------------------------------------------------
// 全局状态：空格平移 / 工具切换清理钢笔 / 动画样式同步
// ---------------------------------------------------------------------------
function isTextInput(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement &&
    (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
  );
}
function onKeyDown(e: KeyboardEvent): void {
  if (e.code === "Space" && !isTextInput(e.target)) {
    spaceHeld.value = true;
    e.preventDefault();
  }
}
function onKeyUp(e: KeyboardEvent): void {
  if (e.code === "Space") spaceHeld.value = false;
}

watch(
  () => store.state.tool,
  (t) => {
    if (t !== "pen") {
      penNodes.value = [];
      activePenIdx.value = null;
    }
    activeAnchorIdx.value = null;
  },
);

watch(
  () => store.state.selectedId,
  () => {
    activeAnchorIdx.value = null;
  },
);

watch(
  () => store.animCss(),
  (css) => {
    if (styleNode) styleNode.textContent = css;
  },
  { immediate: true },
);

onMounted(() => {
  styleNode = document.createElementNS("http://www.w3.org/2000/svg", "style");
  svgRef.value?.appendChild(styleNode);
  resizeObs = new ResizeObserver(() => {
    size.w = Math.max(1, wrapRef.value?.clientWidth ?? 1);
    size.h = Math.max(1, wrapRef.value?.clientHeight ?? 1);
    if (!fitted) {
      fitted = true;
      fitView();
    }
  });
  if (wrapRef.value) resizeObs.observe(wrapRef.value);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
});

onBeforeUnmount(() => {
  styleNode?.remove();
  styleNode = null;
  resizeObs?.disconnect();
  resizeObs = null;
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("keyup", onKeyUp);
});
</script>

<template>
  <div ref="wrapRef" class="sv-stage">
    <svg
      ref="svgRef"
      class="sv-svg"
      :viewBox="viewBoxAttr"
      :style="{ cursor: cursorStyle }"
      @wheel="onWheel"
      @pointerdown="onBgDown($event)"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @dblclick="onRootDblClick($event)"
      @contextmenu.prevent
    >
      <defs>
        <pattern id="sv-grid" width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M 24 0 L 0 0 0 24" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="1" />
        </pattern>
      </defs>

      <!-- 屏幕空间网格 -->
      <rect x="0" y="0" :width="size.w" :height="size.h" fill="url(#sv-grid)" />

      <g :transform="viewTransform">
        <!-- 画板投影 + 画板 -->
        <rect
          :x="-6" :y="-6" :width="store.state.doc.w + 12" :height="store.state.doc.h + 12"
          fill="rgba(0,0,0,0.35)"
        />
        <rect
          :x="0" :y="0" :width="store.state.doc.w" :height="store.state.doc.h"
          fill="#ffffff" stroke="rgba(255,255,255,0.25)"
        />

        <!-- 图层（锁定层 pointer-events:none，点击落到画板 = 取消选中） -->
        <g
          v-for="{ layer, els } in layersWithEls"
          :key="layer.id"
          :opacity="layer.opacity < 1 ? layer.opacity : undefined"
          :style="layer.locked ? 'pointer-events:none' : ''"
        >
          <template v-for="el in els" :key="el.id">
            <rect
              v-if="el.kind === 'rect'"
              :x="el.x" :y="el.y" :width="el.w" :height="el.h"
              :fill="el.style.fill" :stroke="el.style.stroke"
              :stroke-width="el.style.strokeWidth" :stroke-dasharray="dashAttr(el)"
              :opacity="opAttr(el)"
              @pointerdown="onElDown(el, $event)"
            />
            <ellipse
              v-else-if="el.kind === 'ellipse'"
              :cx="el.x + el.w / 2" :cy="el.y + el.h / 2"
              :rx="el.w / 2" :ry="el.h / 2"
              :fill="el.style.fill" :stroke="el.style.stroke"
              :stroke-width="el.style.strokeWidth" :stroke-dasharray="dashAttr(el)"
              :opacity="opAttr(el)"
              @pointerdown="onElDown(el, $event)"
            />
            <line
              v-else-if="el.kind === 'line'"
              :x1="el.x1" :y1="el.y1" :x2="el.x2" :y2="el.y2"
              :stroke="el.style.stroke" :stroke-width="el.style.strokeWidth"
              :stroke-dasharray="dashAttr(el)" stroke-linecap="round"
              :opacity="opAttr(el)"
              @pointerdown="onElDown(el, $event)"
            />
            <polyline
              v-else-if="el.kind === 'pencil'"
              :points="ptsAttr(el.points)"
              fill="none" :stroke="el.style.stroke" :stroke-width="el.style.strokeWidth"
              stroke-linecap="round" stroke-linejoin="round"
              :opacity="opAttr(el)"
              @pointerdown="onElDown(el, $event)"
            />
            <path
              v-else-if="el.kind === 'path'"
              :d="buildPathD(el)"
              :fill="el.style.fill" :stroke="el.style.stroke"
              :stroke-width="el.style.strokeWidth" stroke-linejoin="round"
              :stroke-dasharray="dashAttr(el)"
              :opacity="opAttr(el)"
              @pointerdown="onElDown(el, $event)"
            />
            <text
              v-else-if="el.kind === 'text'"
              :data-el="el.id"
              :x="el.x" :y="el.y"
              :fill="el.style.fill" :font-size="el.style.fontSize"
              :text-anchor="el.style.textAlign === 'center' ? 'middle' : el.style.textAlign === 'right' ? 'end' : undefined"
              :font-family="el.style.fontFamily || DEFAULT_FONT"
              :opacity="opAttr(el)"
              v-bind="textStrokeAttrs(el)"
              @pointerdown="onElDown(el, $event)"
              v-html="buildTextInner(el)"
            ></text>
          </template>
        </g>

        <!-- 创建中的草稿预览 -->
        <template v-if="draft">
          <rect
            v-if="draft.kind === 'rect'"
            :x="draft.x" :y="draft.y" :width="draft.w" :height="draft.h"
            :fill="draft.style.fill" :stroke="draft.style.stroke" :stroke-width="draft.style.strokeWidth"
          />
          <ellipse
            v-else-if="draft.kind === 'ellipse'"
            :cx="draft.x + draft.w / 2" :cy="draft.y + draft.h / 2"
            :rx="draft.w / 2" :ry="draft.h / 2"
            :fill="draft.style.fill" :stroke="draft.style.stroke" :stroke-width="draft.style.strokeWidth"
          />
          <line
            v-else-if="draft.kind === 'line'"
            :x1="draft.x1" :y1="draft.y1" :x2="draft.x2" :y2="draft.y2"
            :stroke="draft.style.stroke" :stroke-width="draft.style.strokeWidth" stroke-linecap="round"
          />
          <polyline
            v-else-if="draft.kind === 'pencil'"
            :points="ptsAttr(draft.points)"
            fill="none" :stroke="draft.style.stroke" :stroke-width="draft.style.strokeWidth"
            stroke-linecap="round" stroke-linejoin="round"
          />
        </template>

        <!-- 钢笔预览：曲线 + 锚点 + 控制柄 -->
        <g v-if="penNodes.length">
          <path
            v-if="penNodes.length > 1"
            :d="penPreviewD"
            fill="none" stroke="#4a9eff" stroke-width="1.5" stroke-dasharray="4 3"
          />
          <template v-for="(n, i) in penNodes" :key="i">
            <line
              v-if="n.ci" :x1="n.p.x" :y1="n.p.y" :x2="n.p.x + n.ci.x" :y2="n.p.y + n.ci.y"
              stroke="rgba(74,158,255,0.55)" stroke-width="1"
            />
            <line
              v-if="n.co" :x1="n.p.x" :y1="n.p.y" :x2="n.p.x + n.co.x" :y2="n.p.y + n.co.y"
              stroke="rgba(74,158,255,0.55)" stroke-width="1"
            />
            <circle
              :cx="n.p.x" :cy="n.p.y"
              :r="activePenIdx === i ? 4.5 : 3"
              :class="{ 'sv-point-active': activePenIdx === i }"
              fill="#4a9eff" stroke="#ffffff" stroke-width="1"
            />
            <circle v-if="n.co" :cx="n.p.x + n.co.x" :cy="n.p.y + n.co.y" r="2.5" fill="#ffffff" stroke="#4a9eff" stroke-width="1" />
            <circle v-if="n.ci" :cx="n.p.x + n.ci.x" :cy="n.p.y + n.ci.y" r="2.5" fill="#ffffff" stroke="#4a9eff" stroke-width="1" />
          </template>
        </g>
      </g>

      <!-- 选中框 + 控制点（屏幕空间，尺寸不随缩放） -->
      <g class="sv-overlay">
        <rect
          v-if="selBox"
          :x="selBox.x" :y="selBox.y" :width="selBox.w" :height="selBox.h"
          fill="none" stroke="#4a9eff" stroke-width="1.5" stroke-dasharray="5 4"
          pointer-events="none"
        />
        <!-- 选中路径：锚点/柄编辑 -->
        <g v-if="store.state.tool === 'select' && pathEditHandleLines.length">
          <line
            v-for="(l, i) in pathEditHandleLines"
            :key="'hl' + i"
            :x1="l.x1" :y1="l.y1" :x2="l.x2" :y2="l.y2"
            stroke="rgba(74,158,255,0.55)" stroke-width="1"
            pointer-events="none"
          />
        </g>
        <g v-if="store.state.tool === 'select' && pathEditAnchors.length">
          <circle
            v-for="(a, i) in pathEditAnchors"
            :key="'pa' + i"
            :cx="a.x" :cy="a.y"
            :r="activeAnchorIdx === i ? 5 : 3.5"
            :class="{ 'sv-point-active': activeAnchorIdx === i }"
            fill="#ffffff" stroke="#4a9eff" stroke-width="1.5"
            style="cursor: move"
            @pointerdown="onPathAnchorDown(i, $event)"
          />
          <circle
            v-for="(h, i) in pathEditHandles"
            :key="'ph' + i"
            :cx="h.x" :cy="h.y" r="3"
            fill="#4a9eff" stroke="#ffffff" stroke-width="1"
            :style="{ cursor: HANDLE_CURSOR }"
            @pointerdown.stop="onPathHandleDown(h.i, h.which, $event)"
          />
        </g>
        <g v-if="store.state.tool === 'select'">
          <rect
            v-for="h in selHandles"
            :key="h.id"
            :x="h.x - 4.5" :y="h.y - 4.5" width="9" height="9"
            fill="#ffffff" stroke="#4a9eff" stroke-width="1.5"
            style="cursor: nwse-resize"
            @pointerdown="onHandleDown(h.id, $event)"
          />
        </g>
      </g>
    </svg>

    <!-- 视口角标：光标世界坐标 / 缩放（点击复位 100%） -->
    <div class="sv-stage-hud mono">
      <span>{{ cursorW.x }}, {{ cursorW.y }}</span>
      <button class="sv-hud-zoom" title="缩放复位 100%" @click="resetZoom">{{ zoomPct }}%</button>
    </div>
  </div>
</template>
