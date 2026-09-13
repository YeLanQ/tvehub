import { reactive } from "vue";

export interface PromptOptions {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  confirmText?: string;
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

export function closePrompt(result: string | null) {
  const r = promptState.resolve;
  promptState.open = false;
  promptState.resolve = null;
  r?.(result);
}