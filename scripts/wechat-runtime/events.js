// 适配层 · 事件桥：wx 触摸 → pointer 事件派发到画布与 window 两个监听面（引擎
// 输入绑定在 canvas 与 window 两处，投递面必须覆盖两者的并集——历史教训）、
// wx.onKeyDown/Up → window key 事件、onShow/onHide → visibilitychange/blur、
// onWindowResize → window resize + 视口状态更新、onError → window error。

import { wxApi, isWechatRuntime, winEvents, view, updateViewSize } from "./env.js";
import { makeEvent } from "./util.js";
import { canvasEvents, screenCanvas } from "./canvas.js";
import { docEvents, visibility } from "./dom.js";

let touchActiveCount = 0;

function pointerEvent(type, touch, changedLen) {
  const x = Number(touch.clientX) || 0;
  const y = Number(touch.clientY) || 0;
  const down = type === "pointerdown";
  return makeEvent(type, {
    pointerId: Number(touch.identifier ?? touch.id ?? 0) || 0,
    pointerType: "touch",
    isPrimary: true,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    pageX: x,
    pageY: y,
    offsetX: x,
    offsetY: y,
    x,
    y,
    button: 0,
    buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
    pressure: down ? 0.5 : type === "pointermove" ? 0.5 : 0,
    detail: 1,
    width: 1,
    height: 1,
    movementX: 0,
    movementY: 0,
    relatedTarget: null,
    target: screenCanvas,
    currentTarget: screenCanvas,
    bubbles: true,
    cancelable: true,
    composed: true,
    __tveTouchCount: changedLen,
  });
}

function dispatchPointer(type, touch, changedLen) {
  const ev = pointerEvent(type, touch, changedLen);
  ev.target = screenCanvas;
  canvasEvents.emit(type, ev);
  // window 监听面（audio 解锁 pointerdown / input 的 window pointerup/pointercancel）
  const winEv = pointerEvent(type, touch, changedLen);
  winEv.target = screenCanvas;
  winEvents.emit(type, winEv);
}

function bridgeTouch(name, type) {
  if (!wxApi || typeof wxApi[name] !== "function") return;
  try {
    wxApi[name]((res) => {
      const touches = (res && (res.changedTouches || res.touches)) || [];
      touchActiveCount = Math.max(0, (res && Array.isArray(res.touches) ? res.touches.length : touchActiveCount) || 0);
      for (const touch of touches) dispatchPointer(type, touch, touches.length);
    });
  } catch (e) {
    console.warn(`[tve-wechat] ${name} 桥接失败`, e);
  }
}

function bridgeKeyboard(name, type) {
  if (!wxApi || typeof wxApi[name] !== "function") return;
  try {
    wxApi[name]((res) => {
      const ev = makeEvent(type, {
        key: (res && (res.key || res.text)) || "",
        code: (res && (res.code || res.keyCode)) || "",
        keyCode: (res && res.keyCode) || 0,
        target: null,
        bubbles: true,
        cancelable: true,
      });
      ev.preventDefault = () => {};
      winEvents.emit(type, ev);
    });
  } catch (e) {
    console.warn(`[tve-wechat] ${name} 桥接失败`, e);
  }
}

function bridgeLifecycle() {
  if (!wxApi) return;
  const setVisible = (hidden) => {
    visibility.hidden = hidden;
    visibility.state = hidden ? "hidden" : "visible";
    const ev = makeEvent("visibilitychange", { target: null, bubbles: true });
    docEvents.emit("visibilitychange", ev);
    if (hidden) winEvents.emit("blur", makeEvent("blur", { target: null }));
  };
  if (typeof wxApi.onShow === "function") {
    try {
      wxApi.onShow(() => setVisible(false));
    } catch {
      /* 生命周期注册失败忽略 */
    }
  }
  if (typeof wxApi.onHide === "function") {
    try {
      wxApi.onHide(() => setVisible(true));
    } catch {
      /* 同上 */
    }
  }
  if (typeof wxApi.onWindowResize === "function") {
    try {
      wxApi.onWindowResize((res) => {
        updateViewSize(res && res.windowWidth, res && res.windowHeight);
        winEvents.emit("resize", makeEvent("resize", { target: null, bubbles: false }));
      });
    } catch {
      /* 同上 */
    }
  }
  if (typeof wxApi.onError === "function") {
    try {
      wxApi.onError((message) => {
        winEvents.emit("error", makeEvent("error", { message: String(message || "未知错误"), bubbles: true }));
      });
    } catch {
      /* 同上 */
    }
  }
}

export function installEventBridges() {
  if (!isWechatRuntime) return;
  bridgeTouch("onTouchStart", "pointerdown");
  bridgeTouch("onTouchMove", "pointermove");
  bridgeTouch("onTouchEnd", "pointerup");
  bridgeTouch("onTouchCancel", "pointercancel");
  bridgeKeyboard("onKeyDown", "keydown");
  bridgeKeyboard("onKeyUp", "keyup");
  bridgeLifecycle();
}

// 求值期安装（bootstrap 以 import 装配，见该文件说明）
installEventBridges();
