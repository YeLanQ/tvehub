// devtools 拆解 —— handlers：devtools 方法的处理器（编辑器窗口执行）。
// 按编辑器（editor/project/scene）、节点（node）、预览（preview/screenshot）、
// 状态（state）、资源（asset）分组；只依赖 app 层 store / lib / api，无生命周期耦合。
//
// 与 LQEN 的差异（本项目场景状态在后端 SceneSession）：
// - 场景 JSON 经 scene_doc 读取、sceneApi.loadDoc 整树替换（含撤销历史重置）；
// - 节点增删改走 engine（乐观应用 + 后端提交 + 撤销历史），与界面操作同一条路；
// - 预览导出复用 WebPreviewPanel 的装配链路（脚本编译 + 运行时 fetch + 后端导出）。

import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getProjectStore, DEFAULT_SCENE_REL } from "../../stores/project";
import { getEditorStore } from "../../stores/editor";
import { getAssetsStore } from "../../stores/assets";
import { getScriptsStore } from "../../stores/scripts";
import { logStore } from "../../stores/log";
import { sceneApi } from "../../../lib/scene-api";
import { api } from "../../../lib/api";
import type { JsonRecord } from "../../../framework/prototype/types";
import { saveCurrentSceneToMain } from "../../lib/save-scene";
import { fetchWebPreviewRuntimeTexts } from "../../lib/web-preview-runtime";
import { loadProjectScripts, compileProjectScripts } from "../../lib/script-compile";
import { enabledMcpTools, sanitizeMcpName } from "./state";
import type { GeometryKind } from "../../../framework/mesh/geometry";
import type { LightKind } from "../../../framework/prototype/nodes/LightNode";
import type { SkyboxKind } from "../../../framework/prototype/nodes/SkyboxNode";

/** 把外部传入的字符串收敛为合法的几何/灯光/天空盒类型（非法值回退默认） */
function asGeometry(v: unknown): GeometryKind {
  const all: GeometryKind[] = ["box", "sphere", "plane", "cylinder", "cone", "torus", "capsule"];
  return all.includes(v as GeometryKind) ? (v as GeometryKind) : "box";
}
function asLightKind(v: unknown): LightKind {
  const all: LightKind[] = ["point", "directional", "ambient", "spot"];
  return all.includes(v as LightKind) ? (v as LightKind) : "point";
}
function asSkyboxKind(v: unknown): SkyboxKind {
  return v === "cube" ? "cube" : "procedural";
}

/** 当前项目根；未打开项目时抛错（各处理器共用） */
function requireRoot(): string {
  const root = getProjectStore().currentPath;
  if (!root) throw new Error("尚未打开项目");
  return root;
}

// ===================== 编辑器 / 项目 / 场景 =====================

/** editor.state：项目/场景/选中/视图/脏标记一览 */
function editorState(): unknown {
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
}

/** project.open：走与首页一致的交接链路（open_project → 事件 → 编辑器装载场景） */
async function projectOpen(path: string): Promise<unknown> {
  if (!path) throw new Error("缺少 path（项目根目录）");
  const project = getProjectStore();
  const ok = await project.openProject(path);
  if (!ok) throw new Error(`打开项目失败: ${path}`);
  await emit("home:project-opened", {
    root: project.currentPath,
    name: project.projectName ?? "",
    rel: project.sceneRel || DEFAULT_SCENE_REL,
  });
  await invoke("show_editor_window");
  return { ok: true, project: project.currentPath };
}

/** project.close：关闭场景会话并切回首页窗口（与界面「关闭项目」一致） */
async function projectClose(): Promise<unknown> {
  await invoke("show_home_window");
  return { ok: true };
}

/** scene.list：项目内 .scene 场景文件 */
async function listScenes(): Promise<unknown> {
  const root = requireRoot();
  const assets = await api.scanAssets(root);
  return assets
    .filter((a) => a.kind === "scene" && !a.path.endsWith("/"))
    .map((a) => ({ name: a.name, path: a.path }));
}

/** scene.tree：后端权威场景文档（完整 JSON） */
async function sceneTree(): Promise<unknown> {
  requireRoot();
  return invoke<unknown>("scene_doc");
}

// ===================== 节点 =====================

/** node.add：与界面同一条写路径（engine 乐观应用 + 后端提交 + 撤销历史）。
 *  type: group(默认)/mesh/light/camera/skybox；mesh/light/skybox 可带子类型。 */
function nodeAdd(params: any): unknown {
  const engine = getEditorStore().engine;
  const parentId = params?.parentId ? String(params.parentId) : undefined;
  const type = String(params?.type ?? "group").toLowerCase();
  const name = params?.name ? String(params.name) : null;
  let node;
  switch (type) {
    case "group":
    case "node":
      node = engine.addEmptyGroup(parentId);
      break;
    case "mesh":
    case "meshnode":
      node = engine.addMesh(asGeometry(params?.geometry ?? "box"), parentId);
      break;
    case "light":
    case "lightnode":
      node = engine.addLight(asLightKind(params?.lightKind ?? "point"), parentId);
      break;
    case "camera":
    case "cameranode":
      node = engine.addCamera(parentId);
      break;
    case "skybox":
    case "skyboxnode":
      node = engine.addSkybox(asSkyboxKind(params?.skyKind ?? "procedural"), parentId);
      break;
    default:
      throw new Error(
        `未知节点类型: ${type}（应为 group/mesh/light/camera/skybox，可带 geometry/lightKind/skyKind）`,
      );
  }
  if (name && node.name !== name) engine.graph.rename(node.id, name);
  return { ok: true, id: node.id, type, name: name ?? node.name };
}

/** node.set：name 走重命名；其余属性走整节点补丁（before/after 快照，一次撤销） */
function nodeSet(params: any): unknown {
  const engine = getEditorStore().engine;
  const id = String(params?.id ?? "");
  const node = engine.graph.get(id);
  if (!node) throw new Error(`未找到节点: ${id}`);
  const prop = String(params?.prop ?? "");
  if (!prop || prop === "id" || prop === "childIds" || prop === "parentId") {
    throw new Error(`不支持设置的属性: ${prop || "(空)"}`);
  }
  if (prop === "name") {
    const v = String(params?.value ?? "");
    engine.graph.rename(id, v);
    return { ok: true, id, prop, value: v };
  }
  const before = node.toJSON() as JsonRecord;
  const after = {
    ...(before as unknown as Record<string, unknown>),
    [prop]: params?.value,
  } as unknown as JsonRecord;
  engine.patchNode(id, before, after, "开发者服务·设置节点");
  return { ok: true, id, prop, value: params?.value };
}

// ===================== 预览 / 截图 =====================

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

/** preview.open：导出并启动预览，再切换到预览页签（WebPreviewPanel 挂载即用现有服务器） */
async function previewOpen(): Promise<unknown> {
  const url = await previewStart();
  getEditorStore().setViewMode("preview");
  return { ok: true, url };
}

/** preview.start：保存场景与脚本 → 导出产物 → 启动（或复用）预览服务器，返回 URL */
async function previewStart(): Promise<string> {
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

/** preview.screenshot：编辑器视口画布截帧（PNG dataURL），并存入项目 .tmp/devtools/ */
async function screenshot(params: any): Promise<unknown> {
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
  void params;
  return { dataUrl, saved };
}

// ===================== 状态快照 =====================

/** state.restore：整树替换后端会话并重建镜像（撤销历史随之重置） */
async function stateRestore(params: any): Promise<unknown> {
  const project = getProjectStore();
  const doc = params?.doc;
  if (!doc || typeof doc !== "object") throw new Error("缺少 doc（state.snapshot 返回的场景文档）");
  const result = await sceneApi.loadDoc(doc, project.currentPath ?? undefined, project.sceneRel || undefined);
  const engine = getEditorStore().engine;
  const rootJson = (result.doc as { root?: unknown } | undefined)?.root ?? null;
  if (rootJson) engine.applySceneDocRoot(rootJson as JsonRecord);
  engine.graph.history.update(result.history);
  return { ok: true };
}

// ===================== 资源 =====================

/** 列出项目资源（全量：脚本/场景/材质/贴图/目录等） */
async function listAssets(): Promise<unknown> {
  const root = requireRoot();
  const assets = await api.scanAssets(root);
  return assets.map((a) => ({ name: a.name, path: a.path, kind: a.kind, size: a.size }));
}

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

/** asset.create：scene/script/material/folder（与资产面板同一条创建链路，自动补 .meta） */
async function createAsset(params: any): Promise<unknown> {
  const root = requireRoot();
  const type = String(params?.type ?? "").toLowerCase();
  const dir = typeof params?.dir === "string" ? params.dir.replace(/\/+$/, "") : "";
  const stem = typeof params?.name === "string" && params.name.trim() ? params.name.trim() : null;
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
      const materialType = String(params?.materialType ?? "");
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
    case "folder": {
      const base = dir ? `${dir}/` : "";
      const name = stem ?? "NewFolder";
      const rel = await store.createFolder(root, `${base}${name}`);
      if (!rel) throw new Error(`创建目录失败: ${base}${name}`);
      return { created: rel, type };
    }
    default:
      throw new Error(`未知资源类型: ${type}（应为 scene/script/material/folder）`);
  }
}

/** 删除资源（文件/目录，移入回收站由后端 delete_asset 决定）。
 *  脚本与资产面板一致走 scripts store：同步移除场景内组件引用与编辑器标签页。 */
async function removeAsset(params: any): Promise<unknown> {
  const root = requireRoot();
  const rel = String(params?.path ?? "");
  if (!rel) throw new Error("缺少 path（项目相对路径）");
  const isScript = (rel === "src" || rel.startsWith("src/")) && rel.endsWith(".ts");
  const ok = isScript
    ? await getScriptsStore().deleteScript(rel)
    : await getAssetsStore().remove(root, rel);
  if (!ok) throw new Error(`删除失败: ${rel}`);
  return { deleted: rel };
}

/** 重命名资源（文件/目录；场景引用随动）。
 *  与资产面板一致：文件新名未带后缀时自动补原扩展名（目录/隐藏文件不补）；
 *  脚本走 scripts store 同步改写场景内组件引用。 */
async function renameAssetEntry(params: any): Promise<unknown> {
  const root = requireRoot();
  const rel = params?.path;
  const newName = params?.newName;
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
}

// ===================== 方法分派 =====================

/** 方法分派：method -> 编辑器动作。params 为外部传入的 JSON 参数。 */
export async function handleMethod(method: string, params: any): Promise<unknown> {
  switch (method) {
    // 编辑器 / 项目
    case "editor.state":
      return editorState();
    case "project.list":
      // 直接查后端最近项目列表（编辑器窗口内存里的 recent 未经首页刷新，常为空）
      return { recent: await invoke<unknown[]>("list_recent_projects") };
    case "project.open":
      return projectOpen(String(params?.path ?? ""));
    case "project.close":
      return projectClose();
    // 场景
    case "scene.list":
      return listScenes();
    case "scene.open":
      return { ok: await getProjectStore().openScene(String(params?.rel ?? "")) };
    case "scene.save":
      await sceneApi.save();
      return { ok: true };
    case "scene.tree":
      return sceneTree();
    // 节点
    case "node.select":
      getEditorStore().engine.select(params?.id ? String(params.id) : null);
      return { ok: true };
    case "node.add":
      return nodeAdd(params);
    case "node.remove":
      getEditorStore().engine.deleteNodes([String(params?.id ?? "")]);
      return { ok: true };
    case "node.rename":
      getEditorStore().engine.graph.rename(String(params?.id ?? ""), String(params?.name ?? ""));
      return { ok: true };
    case "node.set":
      return nodeSet(params);
    // 预览 / 截图
    case "preview.open":
      return previewOpen();
    case "preview.close":
      getEditorStore().setViewMode("scene");
      return { ok: true };
    case "preview.start":
      return { ok: true, url: await previewStart() };
    case "preview.stop":
      await api.stopWebPreview();
      return { ok: true };
    case "preview.screenshot":
      return screenshot(params);
    // 状态
    case "state.snapshot":
      return sceneTree();
    case "state.restore":
      return stateRestore(params);
    // 资源
    case "asset.list":
      return listAssets();
    case "asset.create":
      return createAsset(params);
    case "asset.delete":
      return removeAsset(params);
    case "asset.rename":
      return renameAssetEntry(params);
    // MCP 桥：返回当前「工具权限」已启用的工具清单（MCP tools/list）。
    // name 用 MCP 合法名（下划线），method 保留真实方法名供 tools/call 反查。
    case "mcp.listTools":
      return enabledMcpTools().map((t) => ({
        name: sanitizeMcpName(t.name),
        method: t.name,
        description: t.description,
        inputSchema: { type: "object", properties: {} },
      }));
    default:
      throw new Error(`未知方法: ${method}`);
  }
}
