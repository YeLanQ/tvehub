// 桥接核心 · 画布：屏上画布经端点创建（WebGL 渲染目标），同对象增强（不包装——
// 持有原生引用的调用方自动获得完整 API）；canvas2d 工厂走端点离屏链，失败末级
// 兜底屏上画布（2D 贴图/UI 文本消费）。

import { host, bridgeActive } from "./host.ts";
import { view } from "./env.ts";
import { Emitter } from "./util.ts";

/** 屏上画布事件面（引擎 pointer 监听 + three webglcontextlost 监听共用） */
export const canvasEvents = new Emitter();

function enhanceCanvas(canvas, surface) {
  if (!canvas || typeof canvas !== "object") return canvas;
  if (canvas.__tveEnhanced === true) return canvas; // 幂等：重复增强会丢已注册监听
  try {
    Object.defineProperty(canvas, "__tveEnhanced", { value: true, configurable: true });
  } catch {
    /* 标记失败不阻塞 */
  }
  // 屏上画布共享真实事件面；离屏画布各自独立（无人派发，仅保证形态完整）
  const emitter = surface || new Emitter();
  try {
    if (typeof canvas.addEventListener !== "function") {
      canvas.addEventListener = (type, fn) => emitter.on(type, fn);
      canvas.removeEventListener = (type, fn) => emitter.off(type, fn);
    }
    canvas.getBoundingClientRect = () => ({
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
    Object.defineProperty(canvas, "clientWidth", { configurable: true, get: () => view.width });
    Object.defineProperty(canvas, "clientHeight", { configurable: true, get: () => view.height });
  } catch {
    /* 尺寸访问器安装失败按原生行为 */
  }
  if (!canvas.style || typeof canvas.style !== "object") canvas.style = {};
  return canvas;
}

/** 屏上画布：端点 createScreenCanvas 的首调结果，桥接内仅此一次 */
export const screenCanvas = bridgeActive() ? enhanceCanvas(host().createScreenCanvas(), canvasEvents) : null;

/** canvas2d 工厂：离屏 2D 画布（天空盒程序化贴图 / UI 文本测量等消费）。
 *  端点离屏链失败时末级兜底屏上画布（2D context 获取必败，仅作形态兜底）。 */
export function createCanvas2d(width, height) {
  if (!bridgeActive()) return null;
  let canvas = null;
  try {
    canvas = host().createOffscreenCanvas(width, height);
  } catch {
    canvas = null;
  }
  if (!canvas) canvas = screenCanvas;
  enhanceCanvas(canvas, null);
  try {
    if (width > 0) canvas.width = width;
    if (height > 0) canvas.height = height;
  } catch {
    /* 尺寸设置失败按原生默认 */
  }
  return canvas;
}
