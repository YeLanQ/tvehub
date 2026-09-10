// ---------------------------------------------------------------------------
// 曲线视图（选中通道）：SVG 曲线绘制几何 + 关键帧拖拽 / 空白点击插帧 /
// 贝塞尔切线手柄（自动态虚影、拖即固化、tm 对称联动、权重 wi/wo 拖柄长且
// 曲线随控制点形变）+ 中键抓画布平移。
// 数值轴窗口 = 手动缩放（curveView） > 拖拽冻结快照 > 自动适配；时间轴走
// 共享的 tlT0/zoom 窗口（与 dope 完全同一套方案）。
// ---------------------------------------------------------------------------
import { computed, ref, watch } from "vue";
import {
  TANGENT_WEIGHT_MAX,
  TANGENT_WEIGHT_MIN,
  clampSlope,
  ensureManualTangents,
  evaluateCurve,
  isAutoTangent,
  keySlope,
  keyWeight,
  sampleSmoothSegment,
  tangentWeightBase,
  upsertKey,
  type AnimProp,
} from "../../../framework/animation/clip";
import type { AnimEditorCtx, CurveApi, CurveGeom, TangentHandle } from "./ctx";

type CurveDrag =
  | { kind: "key"; index: number; startX: number; startY: number; live: boolean }
  | { kind: "handle"; index: number; side: "ti" | "to"; base: number; startX: number; startY: number }
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

/** 把手柄端点沿「关键帧 → 理想端点」方向钳到绘图区矩形内：保留角度、只截断
 *  长度，避免近垂直斜率把柄端渲染到画布外（无效拉长）。不改变斜率/权重，
 *  仅限制显示。 */
function clampHandleToPlot(
  kx: number,
  ky: number,
  ex: number,
  ey: number,
  bx0: number,
  by0: number,
  bx1: number,
  by1: number,
): { x: number; y: number } {
  const dx = ex - kx;
  const dy = ey - ky;
  if (dx === 0 && dy === 0) return { x: ex, y: ey };
  // 射线 p = (kx,ky) + t·(dx,dy)，t∈[0,1]；命中最先碰到的那条矩形边
  let t = 1;
  if (dx > 0) t = Math.min(t, (bx1 - kx) / dx);
  else if (dx < 0) t = Math.min(t, (bx0 - kx) / dx);
  if (dy > 0) t = Math.min(t, (by1 - ky) / dy);
  else if (dy < 0) t = Math.min(t, (by0 - ky) / dy);
  t = Math.max(0, t);
  return { x: kx + dx * t, y: ky + dy * t };
}

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
      // smooth 段可能鼓出关键帧值之外：8 等分采样纳入曲线极值（含权重形变）
      for (let i = 0; i + 1 < keys.length; i++) {
        if (keys[i].i !== "smooth") continue;
        const span = Math.max(1e-6, keys[i + 1].t - keys[i].t);
        for (let s = 1; s < 8; s++) {
          const v = sampleSmoothSegment(keys, i, keys[i].t + (span * s) / 8);
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
    // —— 切线手柄 ——
    // 手动态帧常显两侧；选中帧常显两侧虚影（拖即固化——「入段暂为线性不生效」
    // 也要显示：点插值下拉改平滑后立即有柄可拖；出段恒有效，
    // 末帧的 to 对应「末帧 → 右缘水平延长线」）。实线杆+圆点=手动、虚线+
    // 琥珀空心=自动；联动（tm）的 ti 侧为镜像虚影。
    // 注意：手柄纵向占位【不】进值域——否则选中任一帧都会重映射 lo/hi，
    // 其它关键帧与曲线整体「跳位」（编辑态面板偏移抖动）；超出绘图区的手柄
    // 被 svg 裁剪，拖大斜率时自然出界即可。
    const sel = ctx.selection.selected.value;
    const selKey =
      sel && sel.prop === curveProp.value
        ? (keys.find((k) => Math.abs(k.t - sel.t) <= 1e-4) ?? null)
        : null;
    const handles: TangentHandle[] = [];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (isAutoTangent(k) && k !== selKey) continue;
      for (const side of ["ti", "to"] as const) {
        const slope = keySlope(keys, i, side);
        const sgn = side === "to" ? 1 : -1;
        // 手柄长度 = 权重 × 相邻段跨（与曲线控制点同一约定：拖曲线时手柄端点
        // 恰好跟随曲线形变）；钳 0.05s 下限防段跨极小时手柄与帧点重合不可拖
        const base = tangentWeightBase(keys, i, side, d ? d.duration / 4 : 1);
        const span = Math.max(0.05, base * keyWeight(keys, i, side));
        const kx = xOf(k.t);
        const ky = yOf(k.v);
        // 近垂直时斜率巨大，柄端会飞离画布：沿方向钳回绘图区，只截长度不改角
        const end = clampHandleToPlot(kx, ky, xOf(k.t + sgn * span), yOf(k.v + slope * sgn * span), pad, pad, w - pad, h - pad);
        handles.push({
          index: i,
          side,
          base,
          x: end.x,
          y: end.y,
          manual: (side === "ti" ? k.ti : k.to) !== undefined,
          // 弱化：联动（tm）的镜像侧 + 自动态（拖即固化）
          ghost: (k.tm === true && side === "ti") || isAutoTangent(k),
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
            // 权重形变下的参数化 Bézier：按时间均匀采样即视觉均匀（控制点同约定）
            const N = 24;
            for (let s = 1; s <= N; s++) {
              const t = k1.t + (s / N) * span;
              push(t, sampleSmoothSegment(keys, i, t));
            }
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
      // 越侧守卫：指针在帧中心另一侧按下该侧手柄（联动侧手柄
      // 跨过帧中心时常见）→ 本次按下不作用于手柄，落到关键帧命中（选中拖动）
      if ((hitH.side === "to" && localX <= g.xOf(k.t)) || (hitH.side === "ti" && localX >= g.xOf(k.t))) {
        curveDrag = { kind: "key", index: hitH.index, startX: localX, startY: localY, live: false };
        svg.setPointerCapture?.(e.pointerId);
        return;
      }
      const idx = hitH.index;
      if (isAutoTangent(k)) ensureManualTangents(g.keys, idx);
      curveDrag = {
        kind: "handle",
        index: idx,
        side: hitH.side,
        base: hitH.base,
        startX: localX,
        startY: localY,
      };
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
      // 拖手柄会把受影响的段强制转 smooth：线性/阶跃段不读斜率，若不转则
      // 手柄可拖、端点跟着动，但曲线保持直线——用户看到「两端改了面板没变化」
      if (dragNow.side === "to") {
        if (key.i !== "smooth") key.i = "smooth";
      } else {
        const prev = curve.keys[dragNow.index - 1];
        if (prev && prev.i !== "smooth") prev.i = "smooth";
      }
      // 两侧手柄统一按「指针在柄前」的屏幕像素割线换算：s = 沿本侧方向的
      // 像素距离（to 侧向右、ti 侧向左），Δy = 屏幕向上为正。像素斜率再乘
      // （值域跨度/像素高 ÷ 时间跨度/像素宽）换算成 dv/dt——漏掉这个比值
      // 会让算出的斜率与手柄指向差一个缩放因子（左侧手柄拖出近水平的杆、
      // 与入射曲线明显不切，即源于此）。指针在帧中心另一侧时冻结（侧别一致，
      // 不翻转）；贴帧由命中死区兜底，不再用「时间差 < 20ms」限制角度——
      // 那会让手柄拖不出陡峭/接近垂直的角度（拖到约 79° 就卡死）。
      const sgn = dragNow.side === "to" ? 1 : -1;
      const dxPx = sgn * (localX - g.xOf(key.t));
      const dyPx = g.yOf(key.v) - localY;
      const base = Math.max(1e-6, dragNow.base);
      const tScale = Math.max(1e-6, g.t1 - g.t0) / Math.max(1, g.w - g.pad * 2);
      const vScale = (g.hi - g.lo) / Math.max(1, g.h - g.pad * 2);
      if (dxPx < 0) return; // 指针越过帧中心到另一侧：冻结（当前侧的斜率不受影响）
      // 分母给 1px 下限防除零；斜率上限由 clampSlope 收敛（近垂直 = 含无穷斜率）
      const slope = clampSlope(((sgn * dyPx) / Math.max(1, dxPx)) * (vScale / tScale));
      key[dragNow.side] = slope;
      // 水平分量写入权重（相对基准段跨）：手柄长度可编辑，曲线随控制点真实形变
      const w = Math.min(Math.max((dxPx * tScale) / base, TANGENT_WEIGHT_MIN), TANGENT_WEIGHT_MAX);
      key[dragNow.side === "to" ? "wo" : "wi"] = w;
      if (key.tm) {
        const opp = dragNow.side === "to" ? "ti" : "to";
        key[opp] = slope;
        key[opp === "to" ? "wo" : "wi"] = w;
      }
      ctx.clip.touch();
      return;
    }
    if (!dragNow.live) {
      if (Math.hypot(localX - dragNow.startX, localY - dragNow.startY) < 3) return;
      dragNow.live = true;
    }
    // 自动态帧拖动先固化当前切线（值改后自动斜率会变，不固化会跳变）
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