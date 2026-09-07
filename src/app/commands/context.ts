// 命令上下文：dispatch 时对当前窗口/项目状态的一次轻量快照。
// 只依赖 project store（两个窗口都有、不构造引擎），编辑器依赖由命令内部按需获取。

import { getProjectStore } from "../stores/project";
import type { CommandContext } from "./types";

/** 当前焦点是否在文本输入控件里（此时让 WebView 默认文本撤销生效，不做场景撤销） */
export function isEditingText(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable === true;
}

export function createContext(): CommandContext {
  const project = getProjectStore();
  return { view: project.view, hasProject: project.currentPath !== null };
}
