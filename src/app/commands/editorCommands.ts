// 编辑器应用命令：撤销 / 保存 / 关闭项目。
// 原 editor-commands.ts 的 runEditorCommand 收口为命令注册（工具栏/快捷键/菜单事件统一入口）。

import { getEditorStore } from "../stores/editor";
import { getProjectStore } from "../stores/project";
import { getScriptsStore } from "../stores/scripts";
import { logStore } from "../stores/log";
import { api } from "../../lib/api";
import { isTauri } from "../../lib/tauri-env";
import { saveCurrentSceneToMain } from "../lib/save-scene";
import { confirm } from "../lib/confirm";
import { isEditingText } from "./context";
import { registerCommand } from "./registry";
import { disposeEditor } from "../services/editorService";
import { getCurrentWindow } from "@tauri-apps/api/window";

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
  id: "editor.gizmoMode",
  label: "切换变换工具",
  group: "编辑器",
  canRun: (ctx) => ctx.view === "editor",
  description: "切换视口变换工具（mode: translate/rotate/scale；场景/布局视图且非拖拽期间生效，快捷键 W/E/R）",
  run: (_ctx, args: any) => {
    const mode = String(args?.mode ?? "");
    if (mode !== "translate" && mode !== "rotate" && mode !== "scale") return { set: false };
    const store = getEditorStore();
    // 静默守卫：脚本/预览工作台不劫持键位；gizmo 拖拽中切换会打断进行中的变换
    if (
      store.state.viewMode !== "scene" &&
      store.state.viewMode !== "layout"
    ) {
      return { set: false };
    }
    // 地形绘制期间左键归笔刷：不切换变换工具（避免误触改变交互语义）
    if (store.state.terrainPaintActive) return { set: false };
    if (!store.state.mounted || store.engine.gizmo?.isDragging()) return { set: false };
    store.engine.setGizmoMode(mode);
    return { set: true, mode };
  },
});

registerCommand({
  id: "editor.focusSelected",
  label: "聚焦选中对象",
  group: "编辑器",
  canRun: (ctx) => ctx.view === "editor",
  description:
    "视口相机快速聚焦对象（取世界包围球完整取景，沿当前视线退到全览距离；id 缺省 = 当前选中节点。层级双击 / 快捷键 F）",
  run: (_ctx, args: any) => {
    const store = getEditorStore();
    // 静默守卫：脚本/预览工作台不劫持键位（与 editor.gizmoMode 同口径）
    if (
      store.state.viewMode !== "scene" &&
      store.state.viewMode !== "layout"
    ) {
      return { focused: false };
    }
    const id = args?.id ? String(args.id) : store.state.selectedId;
    if (!id || !store.state.mounted) return { focused: false };
    return { focused: store.engine.focusOnNode(id) };
  },
});

registerCommand({
  id: "editor.terrainPaint",
  label: "地形绘制",
  group: "编辑器",
  canRun: (ctx) => ctx.view === "editor",
  description:
    "切换地形表面绘制模式（对已绑定地形材质并生成 Splatmap 的地形，用笔刷把选定材质层画到 splatmap 上；再执行一次退出）",
  run: async () => {
    const store = getEditorStore();
    if (!store.state.mounted || store.state.viewMode !== "scene") {
      return { set: false };
    }
    // 已激活 → 退出
    if (store.state.terrainPaintActive) {
      store.engine.endTerrainPaint();
      store.setTerrainPaint(false);
      logStore.log("info", "已退出地形绘制模式");
      return { set: true, active: false };
    }
    const r = await store.engine.beginTerrainPaint();
    if (!r.ok) {
      logStore.log("warn", `无法开始地形绘制: ${r.reason ?? "未知原因"}`);
      return { set: false };
    }
    // 捕获材质层色（面板层按钮着色；RGBA hex 数字）
    const node = store.engine.getSelectedNode();
    const ms = node && "materialSettings" in node
      ? (node as { materialSettings: { layers: { color: number }[] } | null }).materialSettings
      : null;
    store.setTerrainPaint(true, ms ? ms.layers.map((l) => l.color) : []);
    logStore.log("info", "地形绘制模式：左键涂抹材质层，右键平移/滚轮缩放照常");
    return { set: true, active: true };
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
    // 多会话架构：关闭项目 = 销毁引擎 + 关闭窗口（释放 GPU/Worker/内存）
    // 后端场景会话由 disposeEditor → sceneApi.close 清理
    disposeEditor();
    if (isTauri()) {
      // 显示首页窗口（如果还有其他编辑器窗口开着，首页可能已可见）
      await api.showHomeWindow();
      // 关闭本编辑器窗口（Rust 侧走默认销毁，释放 WebView + GPU 上下文）
      await getCurrentWindow().close().catch(() => {});
    } else {
      project.setView("home");
    }
  },
});
