// 开发者服务（devtools/MCP）域命令：原 devtools/handlers.ts 的远程方法实现迁入命令层，
// 与编辑器 UI 动作共用同一注册表与执行器（node.* 等场景写命令见 nodeCommands.ts）。
// 只保留「读查询 / 会话编排 / 预览截图」等远程入口特有的动作；纯后端方法
// （scene.list/save/tree、asset.list、project.list）后续可下沉 Rust 直接应答。

import { getProjectStore, DEFAULT_SCENE_REL } from "../stores/project";
import { getEditorStore } from "../stores/editor";
import { getAssetsStore } from "../stores/assets";
import { getScriptsStore } from "../stores/scripts";
import { logStore } from "../stores/log";
import { sceneApi } from "../../lib/scene-api";
import { api } from "../../lib/api";
import type { JsonRecord } from "../../framework/prototype/types";
import { saveCurrentSceneToMain } from "../lib/save-scene";
import { fetchWebPreviewRuntimeTexts } from "../lib/web-preview-runtime";
import { loadProjectScripts, compileProjectScripts } from "../lib/script-compile";
import { registerCommand } from "./registry";

/** 当前项目根；未打开项目时抛错（各域命令共用） */
function requireRoot(): string {
  const root = getProjectStore().currentPath;
  if (!root) throw new Error("尚未打开项目");
  return root;
}

/** 组装网页预览导出文件（与 WebPreviewPanel 同一链路：运行时 + 项目配置 + 编译脚本） */
async function buildPreviewFiles(): Promise<Record<string, string>> {
  const root = requireRoot();
  const files = await fetchWebPreviewRuntimeTexts();
  try {
    files["config.json"] = await api.readText(root, "project.config.json");
  } catch {
    files["config.json"] = "{}";
  }
  try {
    await getScriptsStore().saveAll();
  } catch {
    /* 脚本保存失败按磁盘内容导出 */
  }
  try {
    const scripts = await loadProjectScripts(root);
    if (scripts.length) {
      const { files: jsFiles, errors } = await compileProjectScripts(scripts);
      Object.assign(files, jsFiles);
      for (const [rel, err] of Object.entries(errors)) {
        logStore.log("error", `脚本编译失败 ${rel}: ${err}（该脚本不参与预览）`, "preview");
      }
    }
  } catch {
    /* 编译失败跳过用户脚本 */
  }
  return files;
}

// ===================== 编辑器 / 项目 =====================

registerCommand({
  id: "editor.state",
  label: "编辑器状态",
  group: "编辑器",
  expose: true,
  description: "获取编辑器当前状态（项目/场景/选中/视图）",
  run: () => {
    const project = getProjectStore();
    const editor = getEditorStore();
    return {
      project: project.currentPath
        ? { path: project.currentPath, name: project.projectName }
        : null,
      scene: project.currentPath ? project.sceneRel : null,
      selection: editor.state.selectedId,
      selectionIds: editor.state.selectionIds,
      viewMode: editor.state.viewMode,
      dirty: editor.state.dirty,
      mounted: editor.state.mounted,
      canUndo: editor.state.canUndo,
      canRedo: editor.state.canRedo,
    };
  },
});

registerCommand({
  id: "project.recentList",
  label: "查询项目",
  group: "编辑器",
  expose: true,
  description: "列出最近打开的项目",
  run: async () => ({ recent: await api.listRecentProjects() }),
});

registerCommand({
  id: "project.open",
  label: "打开项目",
  group: "编辑器",
  expose: true,
  description: "打开指定路径的项目",
  run: async (_ctx, args: any) => {
    const path = String(args?.path ?? "");
    if (!path) throw new Error("缺少 path（项目根目录）");
    const project = getProjectStore();
    const ok = await project.openProject(path);
    if (!ok) throw new Error(`打开项目失败: ${path}`);
    const { emit } = await import("@tauri-apps/api/event");
    await emit("home:project-opened", {
      root: project.currentPath,
      name: project.projectName ?? "",
      rel: project.sceneRel || DEFAULT_SCENE_REL,
    });
    await api.showEditorWindow();
    return { ok: true, project: project.currentPath };
  },
});

registerCommand({
  id: "project.close",
  label: "关闭项目",
  group: "编辑器",
  expose: true,
  description: "关闭当前项目（返回首页）",
  run: async () => {
    await api.showHomeWindow();
    return { ok: true };
  },
});

// ===================== 场景 =====================

registerCommand({
  id: "scene.list",
  label: "场景列表",
  group: "场景",
  expose: true,
  description: "列出项目内的 .scene 场景文件",
  run: async () => {
    const root = requireRoot();
    const assets = await api.scanAssets(root);
    return assets
      .filter((a) => a.kind === "scene" && !a.path.endsWith("/"))
      .map((a) => ({ name: a.name, path: a.path }));
  },
});

registerCommand({
  id: "scene.open",
  label: "打开场景",
  group: "场景",
  expose: true,
  description: "打开指定场景",
  run: async (_ctx, args: any) => {
    const rel = String(args?.rel ?? "");
    const ok = await getProjectStore().openScene(rel);
    if (!ok) throw new Error(`打开场景失败: ${rel}`);
    return { ok: true };
  },
});

registerCommand({
  id: "scene.save",
  label: "保存场景",
  group: "场景",
  expose: true,
  description: "保存当前场景",
  run: async () => {
    await sceneApi.save();
    return { ok: true };
  },
});

registerCommand({
  id: "scene.doc",
  label: "场景文档",
  group: "场景",
  expose: true,
  description: "获取当前场景的完整 JSON 文档",
  run: () => {
    requireRoot();
    return sceneApi.doc();
  },
});

// ===================== 状态快照 =====================

registerCommand({
  id: "state.restore",
  label: "恢复状态",
  group: "状态",
  expose: true,
  description: "恢复场景快照（传入 scene.doc 返回的 doc）",
  run: async (_ctx, args: any) => {
    const project = getProjectStore();
    const doc = args?.doc;
    if (!doc || typeof doc !== "object") throw new Error("缺少 doc（state.snapshot 返回的场景文档）");
    const result = await sceneApi.loadDoc(doc, project.currentPath ?? undefined, project.sceneRel || undefined);
    const engine = getEditorStore().engine;
    const rootJson = (result.doc as { root?: unknown } | undefined)?.root ?? null;
    if (rootJson) engine.applySceneDocRoot(rootJson as JsonRecord);
    engine.graph.history.update(result.history);
    return { ok: true };
  },
});

// ===================== 预览 / 截图 =====================

/** 保存场景并导出产物 → 启动（或复用）预览服务器，返回 URL */
async function previewStartUrl(): Promise<string> {
  const project = getProjectStore();
  const root = requireRoot();
  try {
    await saveCurrentSceneToMain();
  } catch {
    /* 按磁盘内容导出 */
  }
  const files = await buildPreviewFiles();
  await api.exportWebPreviewFromScene(root, project.sceneRel || DEFAULT_SCENE_REL, files);
  return api.startWebPreviewServer(root);
}

registerCommand({
  id: "preview.open",
  label: "打开预览",
  group: "预览",
  expose: true,
  description: "打开网页预览（导出并启动预览面板）",
  run: async () => {
    const url = await previewStartUrl();
    getEditorStore().setViewMode("preview");
    return { ok: true, url };
  },
});

registerCommand({
  id: "preview.close",
  label: "关闭预览",
  group: "预览",
  expose: true,
  description: "关闭预览面板，返回场景编辑",
  run: () => {
    getEditorStore().setViewMode("scene");
    return { ok: true };
  },
});

registerCommand({
  id: "preview.start",
  label: "启动预览",
  group: "预览",
  expose: true,
  description: "启动预览服务器（按现有导出产物）",
  run: async () => ({ ok: true, url: await previewStartUrl() }),
});

registerCommand({
  id: "preview.stop",
  label: "停止预览",
  group: "预览",
  expose: true,
  description: "停止预览服务器",
  run: async () => {
    await api.stopWebPreview();
    return { ok: true };
  },
});

registerCommand({
  id: "preview.screenshot",
  label: "截图",
  group: "屏幕快照",
  expose: true,
  description: "截取当前视口画面（返回 base64 PNG，并存入项目 .tmp/devtools/）",
  run: async () => {
    const engine = getEditorStore().engine;
    const source = engine.renderer.domElement as HTMLCanvasElement;
    if (!source || !source.width) throw new Error("编辑器视口尚未就绪");
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("创建离屏画布失败");
    ctx.drawImage(source, 0, 0);
    const dataUrl = canvas.toDataURL("image/png");
    if (dataUrl.length < 100) throw new Error("截帧失败（画布为空，视口可能未在渲染）");
    let saved: string | null = null;
    const root = getProjectStore().currentPath;
    if (root) {
      // 产物留档到项目 .tmp/devtools/（dataURL 去掉前缀即 base64）
      const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      saved = `.tmp/devtools/screenshot-${Date.now()}.png`;
      try {
        await api.writeAssetBinary(root, saved, b64);
      } catch {
        saved = null;
      }
    }
    return { dataUrl, saved };
  },
});

// ===================== 资源 =====================

registerCommand({
  id: "asset.list",
  label: "资源列表",
  group: "资源",
  expose: true,
  description: "列出项目资源（脚本/场景/材质/贴图/目录等，含相对路径与类型）",
  run: async () => {
    const root = requireRoot();
    const assets = await api.scanAssets(root);
    return assets.map((a) => ({ name: a.name, path: a.path, kind: a.kind, size: a.size }));
  },
});

/** 为目录内基名找不冲突的名字（"name"、"name 2"、"name 3"…） */
function uniqueName(taken: Set<string>, dir: string, stem: string, ext: string): string {
  const prefix = dir ? `${dir}/` : "";
  let name = stem;
  let n = 2;
  while (taken.has(`${prefix}${name}${ext}`.toLowerCase())) name = `${stem} ${n++}`;
  return `${name}${ext}`;
}

/** 去尾部扩展名（scene/script 等创建走 store，store 会补后缀；调用方带后缀会导致双后缀） */
function stripAssetExt(name: string, ext: string): string {
  return name.toLowerCase().endsWith(ext) ? name.slice(0, -ext.length) : name;
}

registerCommand({
  id: "asset.create",
  label: "新建资源",
  group: "资源",
  expose: true,
  description: "新建资源文件或目录（type: scene/script/material/texcube/folder；dir 目标目录；name 名称）",
  run: async (_ctx, args: any) => {
    const root = requireRoot();
    const type = String(args?.type ?? "").toLowerCase();
    const dir = typeof args?.dir === "string" ? args.dir.replace(/\/+$/, "") : "";
    const stem = typeof args?.name === "string" && args.name.trim() ? args.name.trim() : null;
    const store = getAssetsStore();
    await store.load(root);
    const taken = new Set(store.assets.map((a) => a.path.toLowerCase()));
    switch (type) {
      case "scene": {
        const name = uniqueName(taken, dir, stem ?? "NewScene", ".scene");
        // store.createSceneAsset 只接收基名（内部再补 .scene/去重）
        const rel = await store.createSceneAsset(root, dir, stripAssetExt(name, ".scene"));
        if (!rel) throw new Error(`创建场景失败: ${dir}/${name}`);
        return { created: rel, type };
      }
      case "script": {
        const dest = dir && (dir === "src" || dir.startsWith("src/")) ? dir : "src";
        const name = uniqueName(taken, dest, stem ?? "MyScript", ".ts");
        const rel = await store.createScriptAsset(root, dest, stripAssetExt(name, ".ts"));
        if (!rel) throw new Error(`创建脚本失败: ${dest}/${name}`);
        return { created: rel, type };
      }
      case "material": {
        const materialType = String(args?.materialType ?? "");
        // 基名由调用方 name 指定；缺省用类型显示名（store 内部处理）
        const name = stem ?? "";
        const rel = await store.createMaterialAsset(
          root,
          dir,
          materialType,
          stripAssetExt(name, ".mat") || null,
        );
        if (!rel) throw new Error(`创建材质失败: ${dir || "项目根"}`);
        return { created: rel, type, materialType };
      }
      case "texcube": {
        const name = stem ?? "";
        const rel = await store.createTextureCubeAsset(
          root,
          dir,
          stripAssetExt(name, ".texcube") || null,
        );
        if (!rel) throw new Error(`创建 TextureCube 失败: ${dir || "项目根"}`);
        return { created: rel, type };
      }
      case "folder": {
        const base = dir ? `${dir}/` : "";
        const name = stem ?? "NewFolder";
        const rel = await store.createFolder(root, `${base}${name}`);
        if (!rel) throw new Error(`创建目录失败: ${base}${name}`);
        return { created: rel, type };
      }
      default:
        throw new Error(`未知资源类型: ${type}（应为 scene/script/material/texcube/folder）`);
    }
  },
});

registerCommand({
  id: "asset.delete",
  label: "删除资源",
  group: "资源",
  expose: true,
  description: "删除资源文件或目录（path：项目相对路径）",
  run: async (_ctx, args: any) => {
    const root = requireRoot();
    const rel = String(args?.path ?? "");
    if (!rel) throw new Error("缺少 path（项目相对路径）");
    const isScript = (rel === "src" || rel.startsWith("src/")) && rel.endsWith(".ts");
    const ok = isScript
      ? await getScriptsStore().deleteScript(rel)
      : await getAssetsStore().remove(root, rel);
    if (!ok) throw new Error(`删除失败: ${rel}`);
    return { deleted: rel };
  },
});

registerCommand({
  id: "asset.rename",
  label: "重命名资源",
  group: "资源",
  expose: true,
  description: "重命名资源文件或目录（path + newName）",
  run: async (_ctx, args: any) => {
    const root = requireRoot();
    const rel = args?.path;
    const newName = args?.newName;
    if (!rel) throw new Error("缺少 path（项目相对路径）");
    if (!newName) throw new Error("缺少 newName（新名称）");
    let finalName = String(newName).trim();
    const slash = String(rel).lastIndexOf("/");
    const dot = String(rel).lastIndexOf(".");
    if (dot > slash && dot > 0 && !finalName.includes(".")) {
      finalName = finalName + String(rel).slice(dot);
    }
    const relStr = String(rel);
    const isScript = (relStr === "src" || relStr.startsWith("src/")) && relStr.endsWith(".ts");
    const renamed = isScript
      ? await getScriptsStore().renameScript(relStr, finalName)
      : await getAssetsStore().rename(root, relStr, finalName);
    if (!renamed) throw new Error(`重命名失败: ${relStr}`);
    return { renamed: relStr, newName: renamed };
  },
});
