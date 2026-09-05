// 应用级编辑器命令（撤销 / 保存 / 关闭）。
// 与具体 UI 组件生命周期解耦：工具栏按钮与原生菜单/快捷键事件（Rust 侧
// editor-command 事件）都走这里，避免直接依赖挂载中的组件/引擎。

import { getEditorStore } from "../stores/editor";
import { getProjectStore } from "../stores/project";
import { logStore } from "../stores/log";
import { saveCurrentSceneToMain } from "./save-scene";

export type EditorCommand = "undo" | "save" | "close";

/** 当前焦点是否在文本输入控件里（此时让 WebView 默认文本撤销生效，不做场景撤销） */
function editingText(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    (el as HTMLElement).isContentEditable === true
  );
}

/** 执行编辑器命令（在非编辑器视图 / 未挂载时安全忽略） */
export function runEditorCommand(cmd: EditorCommand): void {
  const project = getProjectStore();
  if (project.view !== "editor") return;

  switch (cmd) {
    case "undo": {
      if (editingText()) return;
      const store = getEditorStore();
      if (store.state.mounted) store.engine.undo();
      break;
    }
    case "save": {
      void saveCurrentSceneToMain()
        .then(() => logStore.log("success", "场景已保存", "toolbar"))
        .catch((e) => logStore.log("error", `场景保存失败: ${e}`, "toolbar"));
      break;
    }
    case "close": {
      project.setView("home");
      break;
    }
  }
}
