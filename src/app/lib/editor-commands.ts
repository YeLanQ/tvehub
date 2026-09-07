// 应用级编辑器命令（撤销 / 保存 / 关闭）。
// 与具体 UI 组件生命周期解耦：工具栏按钮与原生菜单/快捷键事件（Rust 侧
// editor-command 事件）都走这里，避免直接依赖挂载中的组件/引擎。
// 保存成功会清除脏标记；关闭时若有未保存修改先询问（保存并关闭 / 放弃 / 取消）。

import { getEditorStore } from "../stores/editor";
import { getProjectStore } from "../stores/project";
import { getScriptsStore } from "../stores/scripts";
import { logStore } from "../stores/log";
import { invoke } from "@tauri-apps/api/core";
import { sceneApi } from "../../lib/scene-api";
import { api } from "../../lib/api";
import { isTauri } from "../../lib/tauri-env";
import { saveCurrentSceneToMain } from "./save-scene";
import { confirm } from "./confirm";

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
export async function runEditorCommand(cmd: EditorCommand): Promise<void> {
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
      const editor = getEditorStore();
      try {
        await saveCurrentSceneToMain();
        editor.markSaved();
        logStore.log("success", "场景已保存", "toolbar");
      } catch (e) {
        logStore.log("error", `场景保存失败: ${e}`, "toolbar");
      }
      // 脚本工作台中的脏脚本一并保存（保存 = 写盘 + 编译）
      if (editor.state.viewMode === "script") {
        await getScriptsStore().saveAll();
      }
      break;
    }
    case "close": {
      const editor = getEditorStore();
      // 有未保存修改 → 提醒：保存并关闭 / 放弃 / 取消
      if (editor.dirty()) {
        const saveFirst = await confirm({
          title: "未保存的修改",
          message: "当前场景有未保存的修改。是否先保存再关闭？",
          confirmText: "保存并关闭",
          cancelText: "取消",
        });
        if (saveFirst) {
          try {
            await saveCurrentSceneToMain();
            editor.markSaved();
          } catch (e) {
            logStore.log("error", `保存失败，未关闭: ${e}`, "toolbar");
            return;
          }
        } else {
          const discard = await confirm({
            title: "放弃修改",
            message: "放弃未保存的修改并关闭项目？",
            confirmText: "放弃并关闭",
            cancelText: "返回",
            danger: true,
          });
          if (!discard) return;
        }
      }
      // 关闭后端场景会话与 asset:// 协议项目根（下次打开项目时重建）
      void sceneApi.close().catch(() => {});
      void api.setCurrentProjectRoot(null).catch(() => {});
      // 双窗口：显示首页窗口（Rust 侧隐藏编辑器窗口，保留编辑器前端状态）；
      // 浏览器环境无窗口系统，回退单窗口内的视图切换
      if (isTauri()) {
        await invoke("show_home_window");
      } else {
        project.setView("home");
      }
      break;
    }
  }
}
