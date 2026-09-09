// ---------------------------------------------------------------------------
// 曲线视图（选中通道）：SVG 曲线绘制几何 + 关键帧拖拽 / 空白点击插帧 /
// 贝塞尔切线手柄（自动态虚影、拖即固化、tm 对称联动）+ 中键抓画布平移。
// 数值轴窗口 = 手动缩放（curveView） > 拖拽冻结快照 > 自动适配；时间轴走
// 共享的 tlT0/zoom 窗口（与 dope 完全同一套方案）。
// ---------------------------------------------------------------------------
import { computed, ref, watch } from "vue";
import {
  clampSlope,
  ensureManualTangents,
  evaluateCurve,
  isAutoTangent,
  keySlope,
  upsertKey,
  type AnimKey,
  type AnimProp,
} from "../../../framework/animation/clip";
import type { AnimEditorCtx, CurveApi, CurveGeom, TangentHandle } from "./ctx";

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

export function useAnimCurve(ctx: AnimEditorCtx): CurveApi {
  const curveSvgEl = ref<SVGSVGElement | null>(null);

  const curveProp = ref<AnimProp>("");

  /** 曲线视图数值轴窗口（null = 自动适配；时间轴走共享的 tlT0/zoom 窗口） */
  const curveView = ref<{ lo: number; hi: number } | null>(null);
  /** 数值轴缩放滑条倍率（0.2 = 视野缩到 1/5 即放大 5 倍，4 = 拉远 4 倍） */
  const curveZoom = ref(1);
  /** 曲线视图中键平移中（grab 光标态） */
  const curvePanning = ref(false);

  let curveDrag: CurveDrag = null;
  /** 拖拽期间的数值窗快照（冻结自动适配）：防止被拖帧/切线的值变化实时重映射
   *  整条曲线导致漂移抖动；松手恢复。手动缩放（curveView）优先于快照 */
  let curveViewFreeze: { lo: number; hi: number } | null = null;

  const curveOf = ctx.tracks.curveOf;

  /** 自动适配值域：关键帧值 + smooth 曲线鼓包极值 + 播放头采样值（保证可以其为中心缩放） */
  function fitCurveView(): { lo: number; hi: number } {
    const d = ctx.clip.doc.value;
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
      const pv = evaluateCurve(curve, ctx.playback.time.value);
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
    const curve = ctx.clip.doc.value?.curves.find((c) => c.prop === curveProp.value) ?? null;
    const pv = curve ? evaluateCurve(curve, ctx.playback.time.value) : null;
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

  /** 切剪辑/通道时的整体复位（含拖拽快照；模板「适配」按钮只用 resetCurveView） */
  function reset(): void {
    curveView.value = null;
    curveZoom.value = 1;
    curveViewFreeze = null;
  }

  function freezeCurveView(): void {
    if (curveView.value) return; // 已有手动数值窗，本就不变，无需快照
    const g = curveGeom.value;
    curveViewFreeze = { lo: g.lo, hi: g.hi };
  }

  const curveGeom = computed<CurveGeom>(() => {
    void ctx.clip.rev.value;
    const d = ctx.clip.doc.value;
    const curve = d?.curves.find((c) => c.prop === curveProp.value) ?? null;
    const keys = curve?.keys ?? [];
    // viewBox 与元素实测尺寸严格一致（width/height:100%）：保证指针像素坐标
    // 与 viewBox 坐标 1:1，命中判定不偏移；不能加尺寸下限（会破坏等比）
    const w = Math.max(1, ctx.timeline.laneWidth.value);
    const h = Math.max(1, ctx.timeline.laneHeight.value);
    const pad = 16;
    // 数值窗：手动缩放 > 拖拽冻结快照 > 自动适配；时间窗 = 共享时间窗（与 dope 同步）
    const vview = curveView.value ?? (curveDrag && curveViewFreeze ? curveViewFreeze : fitCurveView());
    const win = ctx.timeline.tWindow.value;
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
    const sel = ctx.selection.selected.value;
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

  // —— 指针交互 ——

  /** 平移期间拦截中键默认行为（与 dope 同一套兜底：Chromium/WebView2 的
   *  中键自动滚动，仅 pointerdown preventDefault 在部分版本压不住） */
  function panSuppress(e: Event): void {
    e.preventDefault();
  }
  function panSuppressBind(): void {
    window.addEventListener("mousedown", panSuppress, true);
    window.addEventListener("auxclick", panSuppress, true);
    window.addEventListener("dragstart", panSuppress, true);
  }
  function panSuppressUnbind(): void {
    window.removeEventListener("mousedown", panSuppress, true);
    window.removeEventListener("auxclick", panSuppress, true);
    window.removeEventListener("dragstart", panSuppress, true);
  }

  function onCurveDown(e: PointerEvent): void {
    const d = ctx.clip.doc.value;
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
      panSuppressBind();
      const win = ctx.timeline.tWindow.value;
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
      ctx.selection.pickKey(curveProp.value, k.t);
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
      ctx.selection.pickKey(curveProp.value, hit.t);
      // live=false：先按点击处理，移出死区才转拖拽（防止点选时的抖动改值）
      curveDrag = { kind: "key", index: g.keys.indexOf(hit), startX: localX, startY: localY, live: false };
    } else {
      const t = ctx.timeline.snapT(g.tOf(localX), d.duration, ctx.timeline.snapEnabled.value && !e.altKey);
      const v = g.vOf(localY);
      const curve = curveOf(d, curveProp.value);
      upsertKey(curve, t, v);
      ctx.selection.pickKey(curveProp.value, t);
      curveDrag = {
        kind: "key",
        index: curve.keys.findIndex((k) => Math.abs(k.t - t) <= 1e-4),
        startX: localX,
        startY: localY,
        live: true,
      };
      ctx.clip.touch();
    }
    svg.setPointerCapture?.(e.pointerId);
  }

  function onCurveMove(e: PointerEvent): void {
    const d = ctx.clip.doc.value;
    const dragNow = curveDrag;
    if (!dragNow || !d || !curveSvgEl.value) return;
    const r = curveSvgEl.value.getBoundingClientRect();
    const g = curveGeom.value;
    const localX = e.clientX - r.left;
    const localY = e.clientY - r.top;
    if (dragNow.kind === "pan") {
      // 中键已松开（边缘情况：up 未送达）——等真正按下再动
      if (e.buttons === 0) return;
      // 与 dope 同一条 1× 规则：全览时水平左拖出 80px 无平移余量 → 自动放大
      // 一级（视口中心为锚），并以放大后的窗口重新取平移基准（续拖无跳变）；
      // 放大后 tSpan 变短必须一并重取，保证抓画布换算自洽
      const dx = localX - dragNow.startX;
      if (ctx.timeline.zoom.value === 1 && dx < 0 && -dx > 80) {
        ctx.timeline.setTWindow(
          ctx.timeline.zoom.value + 1,
          0.5,
          (ctx.timeline.tWindow.value.t0 + ctx.timeline.tWindow.value.t1) / 2,
        );
        const win = ctx.timeline.tWindow.value;
        dragNow.startT0 = win.t0;
        dragNow.tSpan = win.t1 - win.t0;
        dragNow.startX = localX;
      }
      // 抓画布：按下瞬间画布下的 (t, v) 必须始终跟在指针下
      const plotW = Math.max(1, g.w - g.pad * 2);
      const plotH = Math.max(1, g.h - g.pad * 2);
      const tHold = dragNow.startT0 + ((dragNow.startX - g.pad) / plotW) * dragNow.tSpan;
      ctx.timeline.applyT0(tHold - ((localX - g.pad) / plotW) * dragNow.tSpan, ctx.timeline.zoom.value);
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
      ctx.clip.touch();
      return;
    }
    if (!dragNow.live) {
      if (Math.hypot(localX - dragNow.startX, localY - dragNow.startY) < 3) return;
      dragNow.live = true;
    }
    // Unity 式：自动态帧拖动先固化当前切线（值改后自动斜率会变，不固化会跳变）
    if (isAutoTangent(key)) ensureManualTangents(curve.keys, dragNow.index);
    key.t = ctx.timeline.snapT(g.tOf(localX), d.duration, ctx.timeline.snapEnabled.value && !e.altKey);
    // 数值钳回可视窗：缩放后拖到底/顶不会把关键帧「拖出视野失联」
    key.v = Math.min(Math.max(g.vOf(localY), g.lo), g.hi);
    curve.keys.sort((a, b) => a.t - b.t);
    dragNow.index = curve.keys.indexOf(key);
    ctx.selection.selected.value = { prop: curveProp.value, t: key.t };
    ctx.clip.touch();
  }

  function onCurveUp(): void {
    panSuppressUnbind();
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

  /** 曲线视图滚轮：与 dope 完全同一套方案——滚轮缩放共享时间窗（指针时刻不动）、
   *  Ctrl+滚轮平移、Shift+滚轮不拦截（统一方案）；数值轴不设鼠标滚轮操作，
   *  用中键纵向拖拽平移或工具条「值×」滑条调整。 */
  function onCurveWheel(e: WheelEvent): void {
    const d = ctx.clip.doc.value;
    const svg = curveSvgEl.value;
    if (!d || !svg) return;
    if (e.shiftKey && !e.ctrlKey) return; // 与 dope 一致：Shift 滚轮不拦截
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const frac = (e.clientX - r.left - 16) / Math.max(1, r.width - 32);
    ctx.timeline.timelineWheel(e, Math.min(Math.max(frac, 0), 1));
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
    if (hit) ctx.selection.onKeyMenu(e, curveProp.value, hit.t);
  }

  return {
    curveProp,
    curveSvgEl,
    curveView,
    curveZoom,
    curveGeom,
    curvePanning,
    resetCurveView,
    onCurveZoomInput,
    onCurveDown,
    onCurveMove,
    onCurveUp,
    onCurveWheel,
    onCurveContextMenu,
    isAutoTangent,
    reset,
  };
}