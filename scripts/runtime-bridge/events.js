// 桥接核心 · 事件桥：平台触摸 → pointer 事件派发到画布与 window 两个监听面
// （引擎输入绑定在 canvas 与 window 两处，投递面必须覆盖两者的并集——历史教训）、
// 平台键盘 → window key 事件、onShow/onHide → visibilitychange/blur、
// onWindowResize → window resize + 视口状态更新、onError → window error。
// 平台接线全部经端点（host），本模块只做事件合成与投递（平台无关）。

import { host, bridgeActive } from "./host.js";
import { winEvents } from "./env.js";
import { makeEvent } from "./util.js";
import { canvasEvents, screenCanvas } from "./canvas.js";
import { docEvents, visibility } from "./dom.js";

function pointerEvent(type, touch) {
  const x = Number(touch.clientX) || 0;
  const y = Number(touch.clientY) || 0;
  const down = type === "pointerdown";
  return makeEvent(type, {
    pointerId: Number(touch.identifier ?? 0) || 0,
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
  });
}

function dispatchPointer(type, touch) {
  const ev = pointerEvent(type, touch);
  ev.target = screenCanvas;
  canvasEvents.emit(type, ev);
  // window 监听面（audio 解锁 pointerdown / input 的 window pointerup/pointercancel）
  const winEv = pointerEvent(type, touch);
  winEv.target = screenCanvas;
  winEvents.emit(type, winEv);
}

function bridgeTouch(name, type) {
  try {
    host()[name]((touch) => dispatchPointer(type, touch));
  } catch (e) {
    console.warn(`[runtime-bridge] ${name} 桥接失败`, e);
  }
}

function bridgeKeyboard(name, type) {
  try {
    host()[name]((keyInfo) => {
      const ev = makeEvent(type, { ...keyInfo, target: null, bubbles: true, cancelable: true });
      ev.preventDefault = () => {};
      winEvents.emit(type, ev);
    });
  } catch (e) {
    console.warn(`[runtime-bridge] ${name} 桥接失败`, e);
  }
}

function bridgeLifecycle() {
  const setVisible = (hidden) => {
    visibility.hidden = hidden;
    visibility.state = hidden ? "hidden" : "visible";
    const ev = makeEvent("visibilitychange", { target: null, bubbles: true });
    docEvents.emit("visibilitychange", ev);
    if (hidden) winEvents.emit("blur", makeEvent("blur", { target: null }));
  };
  try {
    host().onShow(() => setVisible(false));
  } catch {
    /* 生命周期注册失败忽略 */
  }
  try {
    host().onHide(() => setVisible(true));
  } catch {
    /* 同上 */
  }
  try {
    host().onWindowResize(({ width, height }) => {
      updateViewSize(width, height);
      winEvents.emit("resize", makeEvent("resize", { target: null, bubbles: false }));
    });
  } catch {
    /* 同上 */
  }
  try {
    host().onError((message) => {
      winEvents.emit("error", makeEvent("error", { message, bubbles: true }));
    });
  } catch {
    /* 同上 */
  }
}

export function installEventBridges() {
  if (!bridgeActive()) return;
  bridgeTouch("onTouchStart", "pointerdown");
  bridgeTouch("onTouchMove", "pointermove");
  bridgeTouch("onTouchEnd", "pointerup");
  bridgeTouch("onTouchCancel", "pointercancel");
  bridgeKeyboard("onKeyDown", "keydown");
  bridgeKeyboard("onKeyUp", "keyup");
  bridgeLifecycle();
}

// 求值期安装（渠道入口以 import 装配，见 entries 说明）
installEventBridges();
