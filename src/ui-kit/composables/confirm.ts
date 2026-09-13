import { reactive } from "vue";

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
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

export function closeConfirm(result: boolean) {
  const r = confirmState.resolve;
  confirmState.open = false;
  confirmState.resolve = null;
  r?.(result);
}