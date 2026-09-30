// 适配层 · 画布：首调 wx.createCanvas() 得屏上画布（WebGL 渲染目标），同对象
// 增强（不包装——持有原生引用的调用方自动获得完整 API）；canvas2d 工厂走
// OffscreenCanvas → 二次 createCanvas → 屏上画布的兜底链（2D 贴图/UI 文本消费）。

import { wxApi, isWechatRuntime, view } from "./env.js";
import { Emitter } from "./util.js";

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

/** 屏上画布：wx.createCanvas() 首调即屏上画布，整个包内只调这一次 */
export const screenCanvas = isWechatRuntime
  ? enhanceCanvas(wxApi.createCanvas(), canvasEvents)
  : null;

/** canvas2d 工厂：离屏 2D 画布（天空盒程序化贴图 / UI 文本测量等消费）。
 *  兜底链：createOffscreenCanvas({type:"2d"}) → createOffscreenCanvas() →
 *  二次 wx.createCanvas()（首画布已被屏上占用，二次得离屏）→ 屏上画布（2D 必败末级）。 */
export function createCanvas2d(width, height) {
  if (!isWechatRuntime) return null;
  let canvas = null;
  try {
    if (typeof wxApi.createOffscreenCanvas === "function") {
      canvas = wxApi.createOffscreenCanvas({ type: "2d", width, height });
    }
  } catch {
    canvas = null;
  }
  if (!canvas) {
    try {
      if (typeof wxApi.createOffscreenCanvas === "function") {
        canvas = wxApi.createOffscreenCanvas();
      }
    } catch {
      canvas = null;
    }
  }
  if (!canvas) {
    try {
      canvas = wxApi.createCanvas();
    } catch {
      canvas = null;
    }
  }
  if (!canvas) canvas = screenCanvas; // 末级：2D context 获取必败，仅作形态兜底
  enhanceCanvas(canvas, null);
  try {
    if (width > 0) canvas.width = width;
    if (height > 0) canvas.height = height;
  } catch {
    /* 尺寸设置失败按原生默认 */
  }
  return canvas;
}
