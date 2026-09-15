// ---------------------------------------------------------------------------
// 时间 / 输入状态（键盘/指针监听 + inputApi）。
// 键盘：多键同时按住（heldKeys 集合）；指针：多点触控（pointersById 按指针
// id 分触点追踪）。engine.input.pointer 为主指针（最后活跃触点）视图，向后
// 兼容旧单指脚本。
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
  // 画布失焦时清空按住状态，避免切页后"卡键/卡指"
  window.addEventListener("blur", () => {
    state.heldKeys.clear();
    state.pointersById.clear();
    state.pointerState.down = false;
  });

  const canvas = state.host && state.host.canvas;
  if (!canvas) return;

  // 事件坐标 → 画布局部 CSS 像素（与 engine.ui.screenToUi 入参同一空间）。
  // 不用 offsetX/offsetY：up/cancel 可能落在画布外（鼠标拖出画布释放），
  // 那时 offsetX 是其他目标元素的空间，clientX - rect.left 恒为画布局部。
  const pointFromEvent = (e) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: typeof e.clientX === "number" ? e.clientX - rect.left : state.pointerState.x,
      y: typeof e.clientY === "number" ? e.clientY - rect.top : state.pointerState.y,
    };
  };

  /** 主指针跟随最后活跃触点；down = 存在按下中的触点 */
  const syncPrimary = (pointerId, x, y) => {
    const st = state.pointerState;
    st.pointerId = pointerId;
    st.x = x;
    st.y = y;
  };

  const onPointerDown = (e) => {
    const pointerId = e.pointerId ?? 0;
    const { x, y } = pointFromEvent(e);
    const pointer = { pointerId, x, y, down: true };
    state.pointersById.set(pointerId, pointer);
    syncPrimary(pointerId, x, y);
    state.pointerState.down = true;
    state.pointerDownHandlers.forEach((fn) => fn({ ...pointer }));
  };

  /** up/cancel 共用：只处理画布上按下过的触点；canvas/window 双路监听按 id 去重 */
  const onPointerGone = (e, canceled) => {
    const pointerId = e.pointerId ?? 0;
    const pointer = state.pointersById.get(pointerId);
    if (!pointer) return;
    const { x, y } = pointFromEvent(e);
    pointer.x = x;
    pointer.y = y;
    state.pointersById.delete(pointerId);
    syncPrimary(pointerId, x, y);
    state.pointerState.down = state.pointersById.size > 0;
    const payload = { ...pointer, down: false };
    if (canceled) state.pointerCancelHandlers.forEach((fn) => fn(payload));
    else state.pointerUpHandlers.forEach((fn) => fn(payload));
  };

  const onPointerMove = (e) => {
    const pointerId = e.pointerId ?? 0;
    const { x, y } = pointFromEvent(e);
    const pointer = state.pointersById.get(pointerId);
    if (pointer) {
      pointer.x = x;
      pointer.y = y;
    }
    syncPrimary(pointerId, x, y);
    state.pointerMoveHandlers.forEach((fn) => fn({ ...state.pointerState }));
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  // 触摸有隐式捕获（up/cancel 派发到画布）；鼠标拖出画布释放只有 window 能收到
  canvas.addEventListener("pointerup", onPointerGone);
  canvas.addEventListener("pointercancel", (e) => onPointerGone(e, true));
  window.addEventListener("pointerup", onPointerGone);
  window.addEventListener("pointercancel", (e) => onPointerGone(e, true));
  canvas.addEventListener("pointermove", onPointerMove);
}

export const inputApi = {
  isKeyDown(key) {
    return state.heldKeys.has(key);
  },
  /** 当前按下的全部按键（实时集合，勿直接修改） */
  keys: state.heldKeys,
  onKeyDown(handler) {
    state.keyDownHandlers.add(handler);
    return () => state.keyDownHandlers.delete(handler);
  },
  onKeyUp(handler) {
    state.keyUpHandlers.add(handler);
    return () => state.keyUpHandlers.delete(handler);
  },
  pointer: state.pointerState,
  /** 按下中的全部触点（pointerId → 状态，实时映射，勿直接修改） */
  pointers: state.pointersById,
  /** 按 pointerId 查触点（未按下返回 null） */
  getPointer(pointerId) {
    return state.pointersById.get(pointerId) ?? null;
  },
  onPointerDown(handler) {
    state.pointerDownHandlers.add(handler);
    return () => state.pointerDownHandlers.delete(handler);
  },
  onPointerUp(handler) {
    state.pointerUpHandlers.add(handler);
    return () => state.pointerUpHandlers.delete(handler);
  },
  onPointerCancel(handler) {
    state.pointerCancelHandlers.add(handler);
    return () => state.pointerCancelHandlers.delete(handler);
  },
  onPointerMove(handler) {
    state.pointerMoveHandlers.add(handler);
    return () => state.pointerMoveHandlers.delete(handler);
  },
};
