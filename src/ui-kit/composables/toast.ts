import { ref } from "vue";

/** 气泡语义级别：决定配色与默认停留时长 */
export type ToastLevel = "info" | "ok" | "warn" | "err";

/** 气泡内的操作按钮（如「重试」「打开目录」）：点击即执行并关闭气泡 */
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastItem {
  id: number;
  level: ToastLevel;
  text: string;
  /** 停留时长（毫秒）：既是自动消失的定时，也是填充条走完的动画时长 */
  duration: number;
  /** 已进入离场过渡（淡出中，随后移除） */
  leaving?: boolean;
  action?: ToastAction;
}

export interface ToastOptions {
  /** 覆盖默认停留时长（见 defaultDuration） */
  duration?: number;
  action?: ToastAction;
}

/**
 * 待展示的气泡队列。每个窗口各自挂载一份 ToastHost 消费它——与 confirm/prompt
 * 同为「窗口内单例」，不做跨窗口广播（各窗口的提示只属于触发它的那个窗口）。
 */
export const toasts = ref<ToastItem[]>([]);

/** 同屏上限：连发消息时挤掉最早一条，避免堆满视口 */
const MAX_VISIBLE = 5;
/** 离场过渡时长，与 toast.scss 中 .leaving 的过渡时长保持一致 */
const LEAVE_MS = 180;

let seq = 0;

export function dismiss(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

/** 进入离场过渡（淡出）后移除；重复调用无副作用 */
export function leave(id: number): void {
  const item = toasts.value.find((t) => t.id === id);
  if (!item || item.leaving) return;
  item.leaving = true;
  setTimeout(() => dismiss(id), LEAVE_MS);
}

export function dismissAll(): void {
  toasts.value = [];
}

/** 错误与警告留给用户更长的阅读时间 */
function defaultDuration(level: ToastLevel): number {
  if (level === "err") return 8000;
  if (level === "warn") return 5000;
  return 3500;
}

/**
 * 弹出一条气泡通知：level 决定配色（info 灰 / ok 绿 / warn 黄 / err 红），
 * 停留 duration 毫秒后自动消失，期间填充条自左向右走完。
 * 返回气泡 id，可交给 dismiss 提前关闭。
 */
export function toast(level: ToastLevel, text: string, opts?: ToastOptions): number {
  const duration = opts?.duration ?? defaultDuration(level);
  const id = ++seq;
  toasts.value.push({ id, level, text, duration, action: opts?.action });
  if (toasts.value.length > MAX_VISIBLE) toasts.value.shift();
  setTimeout(() => leave(id), duration);
  return id;
}

export const toastOk = (text: string, opts?: ToastOptions): number => toast("ok", text, opts);
export const toastInfo = (text: string, opts?: ToastOptions): number => toast("info", text, opts);
export const toastWarn = (text: string, opts?: ToastOptions): number => toast("warn", text, opts);
export const toastErr = (text: string, opts?: ToastOptions): number => toast("err", text, opts);
