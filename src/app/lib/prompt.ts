import { reactive } from "vue";

/**
 * 全局输入弹窗（Prompt Dialog）的单例状态。
 * 任何面板只需调用 prompt() 即可弹出，全局只渲染一个 <PromptDialog />（挂在 App.vue）。
 * Tauri WebView 中 window.prompt 不可用，因此自实现。
 */
export interface PromptOptions {
  title: string;
  /** 输入框前的说明文字（如资产名） */
  label?: string;
  /** 输入框初始值 */
  initial?: string;
  placeholder?: string;
  /** 确认按钮文字，默认 "确定" */
  confirmText?: string;
  /** 取消按钮文字，默认 "取消" */
  cancelText?: string;
}

export interface PromptState {
  open: boolean;
  options: PromptOptions;
  value: string;
  resolve: ((value: string | null) => void) | null;
}

export const promptState = reactive<PromptState>({
  open: false,
  options: { title: "" },
  value: "",
  resolve: null,
});

/** 弹出输入框；resolve 为用户输入的内容（取消返回 null） */
export function prompt(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    promptState.options = {
      confirmText: "确定",
      cancelText: "取消",
      ...options,
    };
    promptState.value = options.initial ?? "";
    promptState.resolve = resolve;
    promptState.open = true;
  });
}

/** 关闭弹窗并返回用户输入（result 为 null 表示取消） */
export function closePrompt(result: string | null) {
  const r = promptState.resolve;
  promptState.open = false;
  promptState.resolve = null;
  r?.(result);
}