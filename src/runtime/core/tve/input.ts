// ---------------------------------------------------------------------------
// 时间 / 输入状态（键盘/指针监听 + inputApi）
// ---------------------------------------------------------------------------
import { state } from "./state";
import { tickTweens } from "../tween";

/** 每帧推进（scripts.mjs 在调用 onUpdate 前驱动） */
export function tickTime(dt) {
  state.timeState.delta = dt > 0 && Number.isFinite(dt) ? dt : 0;
  state.timeState.elapsed += state.timeState.delta;
  state.timeState.frame += 1;
  tickTweens(state.timeState.delta);
}

/** 键盘/指针监听（随 installRuntime 一次性安装；页面级生命周期无需卸载） */
export function installInputListeners() {
  if (state.inputInstalled) return;
  state.inputInstalled = true;

  window.addEventListener("keydown", (e) => {
    if (!state.heldKeys.has(e.code)) {
      state.heldKeys.add(e.code);
      state.keyDownHandlers.forEach((fn) => fn(e.code));
    }
  });
  window.addEventListener("keyup", (e) => {
    if (state.heldKeys.delete(e.code)) state.keyUpHandlers.forEach((fn) => fn(e.code));
  });
  // 画布失焦时清空按住状态，避免切页后"卡键"
  window.addEventListener("blur", () => state.heldKeys.clear());

  const canvas = state.host && state.host.canvas;
  if (!canvas) return;
  const sync = (e) => {
    if (e && typeof e.offsetX === "number") {
      state.pointerState.x = e.offsetX;
      state.pointerState.y = e.offsetY;
    }
  };
  canvas.addEventListener("pointerdown", (e) => {
    sync(e);
    state.pointerState.down = true;
    state.pointerDownHandlers.forEach((fn) => fn({ ...state.pointerState }));
  });
  canvas.addEventListener("pointerup", (e) => {
    sync(e);
    state.pointerState.down = false;
    state.pointerUpHandlers.forEach((fn) => fn({ ...state.pointerState }));
  });
  canvas.addEventListener("pointermove", (e) => {
    sync(e);
    state.pointerMoveHandlers.forEach((fn) => fn({ ...state.pointerState }));
  });
}

export const inputApi = {
  isKeyDown(key) {
    return state.heldKeys.has(key);
  },
  onKeyDown(handler) {
    state.keyDownHandlers.add(handler);
    return () => state.keyDownHandlers.delete(handler);
  },
  onKeyUp(handler) {
    state.keyUpHandlers.add(handler);
    return () => state.keyUpHandlers.delete(handler);
  },
  pointer: state.pointerState,
  onPointerDown(handler) {
    state.pointerDownHandlers.add(handler);
    return () => state.pointerDownHandlers.delete(handler);
  },
  onPointerUp(handler) {
    state.pointerUpHandlers.add(handler);
    return () => state.pointerUpHandlers.delete(handler);
  },
  onPointerMove(handler) {
    state.pointerMoveHandlers.add(handler);
    return () => state.pointerMoveHandlers.delete(handler);
  },
};