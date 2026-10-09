// 桥接核心 · 事件桥：平台触摸 → pointer 事件派发到画布与 window 两个监听面
// （引擎输入绑定在 canvas 与 window 两处，投递面必须覆盖两者的并集——历史教训）、
// 平台键盘 → window key 事件、onShow/onHide → visibilitychange/blur、
// onWindowResize → window resize + 视口状态更新、onError → window error。
// 平台接线全部经端点（host），本模块只做事件合成与投递（平台无关）。

import { host, bridgeActive } from "./host.ts";
import type { HostKey, HostTouch } from "./contract.ts";
import { bridgeLog } from "./log.ts";
import { updateViewSize, winEvents } from "./env.ts";
import { makeEvent, type TveEvent } from "./util.ts";
import { canvasEvents, screenCanvas } from "./canvas.ts";
import { docEvents, visibility } from "./dom.ts";

function pointerEvent(type: string, touch: HostTouch): TveEvent {
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

/** 输入桥诊断读数（audio-diag 弹窗「触」行消费；恒更新，无开关成本）。
 *  lastX/lastY/lastId = 最近一次派发的触点原值——真机横屏坐标空间错位类
 *  问题（x/y 交换、物理像素混入）以此对照视口值判读。 */
export const touchDiag = {
  down: 0,
  move: 0,
  up: 0,
  cancel: 0,
  lastX: -1,
  lastY: -1,
  lastId: -1,
};

function dispatchPointer(type: string, touch: HostTouch): void {
  const ev = pointerEvent(type, touch);
  ev.target = screenCanvas;
  canvasEvents.emit(type, ev);
  // window 监听面（audio 解锁 pointerdown / input 的 window pointerup/pointercancel）
  const winEv = pointerEvent(type, touch);
  winEv.target = screenCanvas;
  winEvents.emit(type, winEv);
  if (type === "pointerdown") touchDiag.down++;
  else if (type === "pointermove") touchDiag.move++;
  else if (type === "pointerup") touchDiag.up++;
  else if (type === "pointercancel") touchDiag.cancel++;
  touchDiag.lastX = Number(touch.clientX) || 0;
  touchDiag.lastY = Number(touch.clientY) || 0;
  touchDiag.lastId = Number(touch.identifier ?? 0) || 0;
}

type TouchBridgeName = "onTouchStart" | "onTouchMove" | "onTouchEnd" | "onTouchCancel";
type KeyBridgeName = "onKeyDown" | "onKeyUp";

function bridgeTouch(name: TouchBridgeName, type: string): void {
  try {
    host()![name]((touch: HostTouch) => dispatchPointer(type, touch));
  } catch (e) {
    bridgeLog("warn", `[runtime-bridge] ${name} 桥接失败`, e);
  }
}

function bridgeKeyboard(name: KeyBridgeName, type: string): void {
  try {
    host()![name]((keyInfo: HostKey) => {
      const ev = makeEvent(type, { ...keyInfo, target: null, bubbles: true, cancelable: true });
      ev.preventDefault = () => {};
      winEvents.emit(type, ev);
    });
  } catch (e) {
    bridgeLog("warn", `[runtime-bridge] ${name} 桥接失败`, e);
  }
}

function bridgeLifecycle(): void {
  const endpoint = host();
  if (!endpoint) return;
  const setVisible = (hidden: boolean): void => {
    visibility.hidden = hidden;
    visibility.state = hidden ? "hidden" : "visible";
    const ev = makeEvent("visibilitychange", { target: null, bubbles: true });
    docEvents.emit("visibilitychange", ev);
    if (hidden) winEvents.emit("blur", makeEvent("blur", { target: null }));
  };
  try {
    endpoint.onShow(() => setVisible(false));
  } catch {
    /* 生命周期注册失败忽略 */
  }
  try {
    endpoint.onHide(() => setVisible(true));
  } catch {
    /* 同上 */
  }
  try {
    endpoint.onWindowResize(({ width, height }) => {
      updateViewSize(width, height);
      winEvents.emit("resize", makeEvent("resize", { target: null, bubbles: false }));
    });
  } catch {
    /* 同上 */
  }
  try {
    endpoint.onError((message: string) => {
      winEvents.emit("error", makeEvent("error", { message, bubbles: true }));
    });
  } catch {
    /* 同上 */
  }
}

export function installEventBridges(): void {
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
