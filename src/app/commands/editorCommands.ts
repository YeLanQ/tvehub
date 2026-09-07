// 编辑器应用命令：撤销 / 保存 / 关闭项目。
// 原 editor-commands.ts 的 runEditorCommand 收口为命令注册（工具栏/快捷键/菜单事件统一入口）。

import { getEditorStore } from "../stores/editor";
import { getProjectStore } from "../stores/project";
import { getScriptsStore } from "../stores/scripts";
import { logStore } from "../stores/log";
import { sceneApi } from "../../lib/scene-api";
import { api } from "../../lib/api";
import { isTauri } from "../../lib/tauri-env";
import { saveCurrentSceneToMain } from "../lib/save-scene";
import { confirm } from "../lib/confirm";
import { isEditingText } from "./context";
import { registerCommand } from "./registry";

registerCommand({
  id: "editor.undo",
  label: "撤销",
  group: "编辑器",
  canRun: (ctx) => ctx.view === "editor" && !isEditingText(),
  run: () => {
    const store = getEditorStore();
    if (store.state.mounted) store.engine.undo();
  },
});

registerCommand({
  id: "editor.save",
  label: "保存",
  group: "编辑器",
  canRun: (ctx) => ctx.view === "editor",
  run: async () => {
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
  },
});

registerCommand({
  id: "editor.close",
  label: "关闭项目",
  group: "编辑器",
  canRun: (ctx) => ctx.view === "editor",
  run: async () => {
    const editor = getEditorStore();
    const project = getProjectStore();
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
      await api.showHomeWindow();
    } else {
      project.setView("home");
    }
  },
});
