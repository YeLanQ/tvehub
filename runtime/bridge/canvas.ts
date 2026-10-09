// 桥接核心 · 画布：屏上画布经端点创建（WebGL 渲染目标），同对象增强（不包装——
// 持有原生引用的调用方自动获得完整 API）；canvas2d 工厂走端点离屏链，失败末级
// 兜底屏上画布（2D 贴图/UI 文本消费）。

import { host, bridgeActive } from "./host.ts";
import { view } from "./env.ts";
import { Emitter } from "./util.ts";

/** 画布鸭子形态（平台画布字段集不一，逐键容错；width/height 为通用消费面） */
type CanvasLike = Record<string, unknown> & { width?: number; height?: number };

/** 屏上画布事件面（引擎 pointer 监听 + three webglcontextlost 监听共用） */
export const canvasEvents = new Emitter();

function enhanceCanvas(canvas: unknown, surface: Emitter | null): unknown {
  if (!canvas || typeof canvas !== "object") return canvas;
  const c = canvas as CanvasLike;
  if (c.__tveEnhanced === true) return canvas; // 幂等：重复增强会丢已注册监听
  try {
    Object.defineProperty(c, "__tveEnhanced", { value: true, configurable: true });
  } catch {
    /* 标记失败不阻塞 */
  }
  // 屏上画布共享真实事件面；离屏画布各自独立（无人派发，仅保证形态完整）
  const emitter = surface || new Emitter();
  try {
    // 强制覆盖而非「缺员补装」：平台画布可能自带原生 addEventListener（模拟器
    // 与真机能力面不一，innerWidth 泄漏同款分叉），而平台原生监听表永远不会
    // 收到桥接合成的 pointer 事件——引擎输入与 UI 按钮注册全被吸进死监听面
    // （真机症状：window 面手势计数照涨、摇杆/按钮全死）。本平台合成触摸是
    // 唯一事件源，覆盖后 three 的 webglcontextlost 落发射器（桥不发射该事件，
    // 等效原生空表）；不向原生接链：模拟器原生触摸若存在亦与 wx.onTouch* 同
    // 源鼠标，双投递只增噪。
    c.addEventListener = (type: unknown, fn: unknown) => emitter.on(type as string, fn);
    c.removeEventListener = (type: unknown, fn: unknown) => {
      emitter.off(type as string, fn as (event: unknown) => void);
    };
    c.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      x: 0,
      y: 0,
      width: view.width,
      height: view.height,
      right: view.width,
      bottom: view.height,
    });
  } catch {
    /* 平台只读属性按原生行为 */
  }
  try {
    Object.defineProperty(c, "clientWidth", { configurable: true, get: () => view.width });
    Object.defineProperty(c, "clientHeight", { configurable: true, get: () => view.height });
  } catch {
    /* 尺寸访问器安装失败按原生行为 */
  }
  if (!c.style || typeof c.style !== "object") c.style = {};
  return canvas;
}

/** 屏上画布：端点 createScreenCanvas 的首调结果，桥接内仅此一次。
 *  注意：微信真机首画布求值期是竖屏占位符（750x1334），不代表最终显示面——
 *  视口唯一可信来源是启动 sys 值（env.applyViewport），此处不得用画布尺寸反推。 */
export const screenCanvas: unknown = bridgeActive()
  ? enhanceCanvas(host()!.createScreenCanvas(), canvasEvents)
  : null;

/** canvas2d 工厂：离屏 2D 画布（天空盒程序化贴图 / UI 文本测量等消费）。
 *  端点离屏链失败时末级兜底屏上画布（2D context 获取必败，仅作形态兜底）。 */
export function createCanvas2d(width: number, height: number): unknown {
  if (!bridgeActive()) return null;
  let canvas: unknown = null;
  try {
    canvas = host()!.createOffscreenCanvas(width, height);
  } catch {
    canvas = null;
  }
  if (!canvas) canvas = screenCanvas;
  enhanceCanvas(canvas, null);
  const c = canvas as CanvasLike;
  try {
    if (width > 0) c.width = width;
    if (height > 0) c.height = height;
  } catch {
    /* 尺寸设置失败按原生默认 */
  }
  return canvas;
}
