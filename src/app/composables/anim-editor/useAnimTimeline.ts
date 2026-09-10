// ---------------------------------------------------------------------------
// 时间轴几何与指针交互（dope / 曲线两视图共用一套时间窗）：
// 窗口 = [t0, t0 + 时长/zoom]。dope 侧以内容层（宽 = 全时长×倍率）+ scrollLeft
// 承载，曲线侧以 viewBox 线性映射消费同一窗口；底部「×」滑条、两个视图的
// 滚轮（以指针为中心缩放，Ctrl+滚轮 = 平移）都驱动同一状态，互相同步。
// 另含：左列/轨道双向滚动同步、标尺刻度自适应、时间吸附、关键帧拖拽、
// 播放头保持可见、轨道区尺寸 ResizeObserver。
// ---------------------------------------------------------------------------
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ensureManualTangents, isAutoTangent } from "../../../framework/animation/clip";
import type { AnimEditorCtx, TimelineApi } from "./ctx";

/** dope 拖拽 / scrub 状态（模块级可变；move 时按事件对象判定） */
type Drag =
  | { kind: "scrub" }
  | { kind: "key"; prop: string; index: number; startX: number; live: boolean }
  | null;

export function useAnimTimeline(ctx: AnimEditorCtx): TimelineApi {
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
  /** 时间吸附（工具条开关，按住 Alt 临时关闭）：对齐到刻度步长的 1/10 细分网格 */
  const snapEnabled = ref(true);
  /** 平移中状态：必须走响应式 :class（命令式 classList 会被 Vue 重渲染冲掉） */
  const lanePanning = ref(false);

  // —— 几何 ——

  const durOf = (): number => Math.max(0.1, ctx.clip.doc.value?.duration ?? 3);

  const pxPerT0 = computed(() => Math.max(1, laneWidth.value) / durOf());
  /** dope 内容层总宽（= 全时长 × 倍率：zoom=1 恰好铺满） */
  const timelineWidth = computed(() => durOf() * zoom.value * pxPerT0.value);
  /** 缩放后指针 x 相对轨道内容原点（需加横向滚动量） */
  function laneScrollX(): number {
    return laneEl.value?.scrollLeft ?? 0;
  }
  /** 可视时间窗（权威状态 tlT0；dope 滚动条通过 @scroll 写回，两视图共享） */
  const tWindow = computed<{ t0: number; t1: number }>(() => {
    const dur = durOf();
    const span = dur / zoom.value;
    const t0 = Math.min(Math.max(tlT0.value, 0), Math.max(0, dur - span));
    return { t0, t1: t0 + span };
  });

  /** 写窗口原点（同步 dope 滚动位置与权威 tlT0） */
  function applyT0(t0: number, z: number): void {
    const dur = durOf();
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
    if (ctx.view.viewMode.value === "dope") {
      tlT0.value = laneScrollX() / Math.max(1e-6, zoom.value * pxPerT0.value);
    } else {
      const dur = durOf();
      const span = dur / zoom.value;
      tlT0.value = Math.min(Math.max(tlT0.value, 0), Math.max(0, dur - span));
      el.scrollLeft = tlT0.value * zoom.value * pxPerT0.value;
    }
  }
  watch(() => ctx.view.viewMode.value, syncTimeWindow);

  /** 统一改倍率（保持锚点：anchorT 时刻停在视图相对位置 anchorFrac 处） */
  function setTWindow(zNew: number, anchorFrac: number, anchorT: number): void {
    const dur = durOf();
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
    if (!laneEl.value || !ctx.clip.doc.value) return;
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

  // —— 中键拖拽平移时间窗（dope：标尺/轨道/内容层按下全局接管；曲线：见曲线模块）——

  let panUp: (() => void) | null = null;
  /** 同一 pointerdown 事件对象（冒泡多路径重入）按事件去重——
   *  不可用 pointerId：鼠标 pointerId 恒定，一次 pointerup 丢失（如窗外释放）
   *  会让基于 pointerId 的重入闸永久拦截后续所有中键 */
  const panHandled = new WeakSet<PointerEvent>();
  /** 当前可视窗每秒像素数（dope 内容层/曲线 viewBox 共用：laneWidth / tSpan）。
   *  平移换算用它，拖动像素 × tSpan/laneWidth = 秒：内容跟指针走（任何缩放一致） */
  const pxPerSec = computed(() => {
    const win = tWindow.value;
    return Math.max(1, laneWidth.value) / Math.max(0.1, win.t1 - win.t0);
  });
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
    if (ctx.view.viewMode.value === "dope") {
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
    if (!el || !ctx.clip.doc.value || ctx.view.viewMode.value !== "dope") return;
    // 重入闸：同一 pointerdown 冒泡经过多条处理路径（ruler→wrap 等），按事件对象去重
    if (panHandled.has(e)) return;
    panHandled.add(e);
    // 自愈：上次平移若丢了 pointerup（窗外释放等），先清理再开始
    panUp?.();
    // 捕获到滚动容器自身（与曲线捕获到 svg 一致）：拖拽期间浏览器按捕获元素的
    // 光标渲染，容器带 panning → grabbing 小手，指针压在标尺/关键帧上也不例外
    el.setPointerCapture?.(e.pointerId);
    // 平移按「相对按下点」计算（若用容器左缘，按下瞬间会跳一段）；
    // 1× 自动放大后重新取基准（let：闭包内重设，续拖无跳变）
    let startX = e.clientX;
    let startT0 = tWindow.value.t0;
    const startY = e.clientY;
    const startTop = el.scrollTop;
    lanePanning.value = true;
    const move = (ev: PointerEvent): void => {
      if (ev.buttons === 0) return; // 中键已松开（边缘情况：up 未送达）
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (zoom.value === 1 && dx < 0 && -dx > 80) {
        // 1× 全览没有横向平移余量：水平拖出 80px 未动 → 自动放大一级（以视口
        // 中心为锚）；放大后取新基准，继续拖动即为平移
        setTWindow(zoom.value + 1, 0.5, (tWindow.value.t0 + tWindow.value.t1) / 2);
        startT0 = tWindow.value.t0;
        startX = ev.clientX;
      }
      // 横向 = 共享时间窗平移：按当前可视像素密度换算（内容跟指针走，
      // 任何缩放下一像素位移对应的秒数与曲线视图一致）
      applyT0(startT0 - (ev.clientX - startX) / pxPerSec.value, zoom.value);
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

  // —— 轨道区尺寸测量（曲线 viewBox / 时间窗换算依赖真实宽高）——

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

  // —— 换算 / 播放头 / 标尺刻度 / 吸附 ——

  function tToX(t: number, duration: number): number {
    return (t / Math.max(0.1, duration)) * timelineWidth.value;
  }
  function xToT(x: number, duration: number): number {
    return Math.max(0, Math.min(duration, (x / Math.max(1, timelineWidth.value)) * duration));
  }

  // 播放/scrub 时把播放头保持在可视范围内（缩放后内容超出视口才有意义）
  watch(
    () => ctx.playback.time.value,
    () => {
      const el = laneEl.value;
      if (!el || ctx.view.viewMode.value !== "dope") return;
      const x = tToX(ctx.playback.time.value, ctx.clip.doc.value?.duration ?? 1);
      if (x < el.scrollLeft) el.scrollLeft = x;
      else if (x > el.scrollLeft + el.clientWidth - 12) el.scrollLeft = x - el.clientWidth + 12;
    },
  );

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

  const rulerTicks = computed<readonly number[]>(() => {
    const { t0, t1 } = tWindow.value;
    const step = rulerStep.value;
    const out: number[] = [];
    // 用整数索引乘步长，避免浮点累加漂移出重复刻度（只生成可视窗内刻度）
    for (let i = Math.ceil(t0 / step - 1e-6); i * step <= t1 + 1e-6; i++) out.push(i * step);
    return out;
  });

  /** 曲线视图网格 = 主刻度 + 缩放态 1/5 细刻度 */
  const curveGridTicks = computed<readonly number[]>(() => {
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

  function snapT(t: number, duration: number, enabled: boolean): number {
    if (!enabled) return t;
    const grid = Math.max(0.001, rulerStep.value / 10);
    return Math.max(0, Math.min(duration, Math.round(t / grid) * grid));
  }

  // —— dope 指针交互：标尺 scrub / 关键帧拖拽 ——

  let drag: Drag = null;

  function beginScrub(e: PointerEvent): void {
    if (e.button === 1) return beginLanePan(e); // 中键 = 平移视图
    if (e.button !== 0) return;
    const rect = laneEl.value?.getBoundingClientRect();
    if (!rect) return;
    laneLeftCache = rect.left;
    drag = { kind: "scrub" };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const dur = ctx.clip.doc.value?.duration ?? 1;
    ctx.playback.time.value = snapT(
      xToT(e.clientX - rect.left + laneScrollX(), dur),
      dur,
      snapEnabled.value && !e.altKey,
    );
    ctx.preview.previewAt(ctx.playback.time.value);
  }

  function beginKeyDrag(e: PointerEvent, prop: string, index: number): void {
    if (e.button === 1) return beginLanePan(e); // 中键 = 平移视图（不选中关键帧）
    if (e.button !== 0) return; // 右键按下留给 contextmenu 菜单，不进拖拽
    const rect = laneEl.value?.getBoundingClientRect();
    if (!rect) return;
    laneLeftCache = rect.left;
    // 选中在按下时即生效（不依赖 click：拖拽后数组重排，click 会命中错误的帧）
    ctx.selection.pickKey(prop, ctx.tracks.keysOf(prop)[index]?.t ?? 0);
    drag = { kind: "key", prop, index, startX: e.clientX - laneLeftCache + laneScrollX(), live: false };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function onRulerPointerMove(e: PointerEvent): void {
    if (!drag || drag.kind !== "scrub") return;
    const d = ctx.clip.doc.value;
    if (!d) return;
    ctx.playback.time.value = snapT(
      xToT(e.clientX - laneLeftCache + laneScrollX(), d.duration),
      d.duration,
      snapEnabled.value && !e.altKey,
    );
    ctx.preview.previewAt(ctx.playback.time.value);
  }

  function onLanePointerMove(e: PointerEvent): void {
    if (!drag || drag.kind !== "key") return;
    const d = ctx.clip.doc.value;
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
    // 自动态帧拖动先固化当前切线（值改后自动斜率会变，不固化会跳变）
    if (isAutoTangent(key)) ensureManualTangents(curve.keys, dragKey.index);
    key.t = snapT(xToT(x, d.duration), d.duration, snapEnabled.value && !e.altKey);
    curve.keys.sort((a, b) => a.t - b.t);
    // 排序后必须回写索引，否则下一次移动事件会抓到别的关键帧
    dragKey.index = curve.keys.indexOf(key);
    ctx.selection.selected.value = { prop: dragKey.prop, t: key.t };
    ctx.clip.touch();
  }

  function onLanePointerUp(): void {
    drag = null;
  }

  return {
    laneEl,
    namesEl,
    laneWidth,
    laneHeight,
    zoom,
    tlT0,
    tWindow,
    timelineWidth,
    applyT0,
    setTWindow,
    timelineWheel,
    onLaneWheel,
    onZoomInput,
    onWrapPointerDown,
    onLanesScroll,
    onNamesScroll,
    beginLanePan,
    lanePanning,
    tToX,
    xToT,
    rulerStep,
    tickDecimals,
    tickLabel,
    rulerTicks,
    tlZoomed,
    curveGridTicks,
    snapEnabled,
    snapT,
    beginScrub,
    beginKeyDrag,
    onRulerPointerMove,
    onLanePointerMove,
    onLanePointerUp,
  };
}