import { reactive } from "vue";

export interface ConfirmOptions {
  title: string;
  message: string;
  /** 确认按钮文字，默认 "确定" */
  confirmText?: string;
  /** 取消按钮文字，默认 "取消" */
  cancelText?: string;
  /** 危险操作（删除等）：确认按钮红色 */
  danger?: boolean;
}

export interface ConfirmState {
  open: boolean;
  options: ConfirmOptions;
  resolve: ((value: boolean) => void) | null;
}

export const confirmState = reactive<ConfirmState>({
  open: false,
  options: { title: "", message: "" },
  resolve: null,
});

/** 弹出确认框，resolve 为 true 表示用户确认 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    confirmState.options = {
      confirmText: "确定",
      cancelText: "取消",
      danger: false,
      ...options,
    };
    confirmState.resolve = resolve;
    confirmState.open = true;
  });
}

/** 关闭弹窗并返回用户选择 */
export function closeConfirm(result: boolean) {
  const r = confirmState.resolve;
  confirmState.open = false;
  confirmState.resolve = null;
  r?.(result);
}