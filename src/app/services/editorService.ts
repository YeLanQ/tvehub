// editorService —— 编辑器生命周期编排（挂载 / 场景装载 / 首页交接 / dispose）。
// 从 stores/editor.ts 抽出：store 只保留 reactive 状态桥与引擎接线，装载编排
// 集中在此（引擎仍由 stores/editor 单例持有，经 getEditorStore 访问）。

import type { EditorEngine } from "../../framework/engine/EditorEngine";
import { buildStarterSceneDoc } from "../../framework/engine/starterScene";
import { DEFAULT_MATERIAL_REL } from "../../framework/material";
import type { JsonRecord } from "../../framework/prototype/types";
import { assetUrl, fetchAssetBinary } from "../../lib/asset-url";
import { sceneApi, type SceneLoadResult } from "../../lib/scene-api";
import { loadMaterialDoc } from "../lib/materials";
import { loadShaderDoc } from "../lib/shaders";
import { logStore } from "../stores/log";
import { getProjectStore } from "../stores/project";
import { getEditorStore, resetEditorEngine } from "../stores/editor";

/** 挂载任务去重：引擎挂载是异步的（渲染后端可能动态加载），并发调用共享同一任务 */
let mountTask: Promise<void> | null = null;
/** 首页窗口交接的项目挂起项：编辑器尚未挂载完成时暂存，就绪后由 mountEditor 补装载 */
let pendingProject: { root: string; rel: string } | null = null;

/**
 * 收到首页窗口的项目交接（home:project-opened 事件，编辑器窗口入口转发）：
 * 同步本地项目状态后，编辑器已挂载 → 立即重装载场景；
 * 尚在挂载中（编辑器窗口刚启动）→ 挂起，由 mountEditor 在就绪后补装载。
 */
export async function handleProjectOpenedFromHome(
  root: string,
  name: string,
  rel: string,
): Promise<void> {
  const projectStore = getProjectStore();
  projectStore.applyOpenedProject(root, name, rel);
  const store = getEditorStore();
  if (store.state.mounted && !store.engine.isDisposed()) {
    // 引擎先于项目挂载（编辑器窗口启动时无项目）：重注入资产访问器后再装载场景
    applyProjectAccess(store.engine, root);
    await reloadEditorScene(root, rel);
  } else {
    pendingProject = { root, rel };
  }
}

/**
 * 按当前项目根（重）注入资产访问器（材质/贴图/模型）。
 * 编辑器窗口启动时可能尚无项目（引擎先于项目挂载，全部注入 null），项目经
 * 首页交接打开后必须重注入，否则贴图/材质/模型读取静默失败（天空 TextureCube
 * 停留在色带兜底、材质通道无贴图、模型不加载）。
 */
function applyProjectAccess(engine: EditorEngine, root: string | null): void {
  // 材质资产来源：后端 material_read（internal/项目路由 + .mat 解析均在 Rust）
  engine.materials.setFetcher(root ? (rel) => loadMaterialDoc(root, rel) : null);
  // 项目切换后旧缓存不可跨项目复用（同 rel 指向不同文件）
  engine.materials.clear();
  // 着色器文档来源：后端 shader_read（渲染分支与源码解析均在 Rust）
  engine.shaders.setFetcher(root ? (rel) => loadShaderDoc(root, rel) : null);
  engine.shaders.clear();
  // 贴图来源：asset:// 协议直读（internal/… 与项目资产统一走协议 URL；
  // setTextureResolver 内部会清贴图/TextureCube 缓存并重算天空背景）
  engine.setTextureResolver(root ? (rel) => (rel ? assetUrl(rel) : null) : null);
  // 模型来源：与贴图同构（协议 URL + 按需流式外部资源；setModelAccess 内部清模型缓存）
  engine.setModelAccess(
    root
      ? {
          readBinary: (rel) => fetchAssetBinary(rel),
          urlFor: (rel) => assetUrl(rel),
        }
      : null,
  );
}

export function mountEditor(container: HTMLElement): Promise<void> {
  const store = getEditorStore();
  if (store.state.mounted) return Promise.resolve();
  if (!mountTask) {
    mountTask = (async () => {
      const engine = store.engine;
      const projectStore = getProjectStore();
      const root = projectStore.currentPath;
      // 相机辅助视锥取景宽高比 = 项目设计分辨率（打开/新建项目时已从 project.config.json 读入）
      engine.designResolution = {
        width: Math.max(1, Math.min(16384, Math.round(projectStore.designWidth))),
        height: Math.max(1, Math.min(16384, Math.round(projectStore.designHeight))),
      };
      applyProjectAccess(engine, root);
      // 物理配置（项目级：引擎/重力/启停）随项目装载生效
      engine.physics.configure({
        backend: projectStore.physicsBackend,
        enabled: projectStore.physicsEnabled,
        gravity: { ...projectStore.physicsGravity },
      });
      // 后端场景会话接线：写通道（乐观提交）+ 变更事件（快照回灌镜像）
      engine.setSceneTransport(sceneApi.transport());
      await engine.bindSceneEvents(sceneApi.subscribe);
      await engine.mount(container, {
        renderer: projectStore.rendererBackend,
        antialias: projectStore.antiAliasing,
        hdrMode: projectStore.hdrMode,
      });
      // 挂载期间被销毁（如就绪前点击"关闭"返回首页）→ 不再装载场景/重建
      if (engine.isDisposed()) return;
      // 场景装载：后端读盘 + 旧格式迁移 + 建图（历史清零），返回规范 doc 与引用清单
      const sceneRel = projectStore.sceneRel;
      let loaded = false;
      if (root && sceneRel) {
        try {
          const result = await sceneApi.open(root, sceneRel);
          if (engine.isDisposed()) return;
          loaded = await applySceneLoadResult(engine, result);
        } catch (e) {
          logStore.log("warn", `场景打开失败（回退初始场景）: ${e}`, "engine");
        }
      }
      if (!loaded && !engine.isDisposed()) {
        // 空场景/损坏场景/未开项目 → 初始场景（经后端 scene_load_doc 落会话；
        // 携带保存目标，新项目首次保存时创建场景文件）
        try {
          await engine.materials.preload([DEFAULT_MATERIAL_REL]);
          if (engine.isDisposed()) return;
          const result = await sceneApi.loadDoc(
            buildStarterSceneDoc(engine.factory),
            root ?? undefined,
            sceneRel || undefined,
          );
          if (engine.isDisposed()) return;
          await applySceneLoadResult(engine, result);
        } catch (e) {
          // 无后端（浏览器直开）或会话异常时保留空场景，编辑器仍视为就绪
          logStore.log("warn", `初始场景装载失败: ${e}`, "engine");
        }
      }
      store.markMounted();
      store.markSaved();
      // 首页窗口在挂载期间交接的项目：就绪后补装载（若挂载流程已按同一项目
      // 装载成功则跳过，避免重复 scene_open）
      if (pendingProject) {
        const p = pendingProject;
        pendingProject = null;
        if (!(loaded && root === p.root && sceneRel === p.rel)) {
          await reloadEditorScene(p.root, p.rel);
        }
      }
      logStore.log("info", "编辑器已就绪", "engine");
    })();
  }
  return mountTask;
}

/**
 * 应用后端装载结果：预取引用（材质/模型）→ 镜像重建 → 历史状态同步。
 * 返回是否装载了有效根节点（false = 空场景，调用方回退初始场景）。
 */
async function applySceneLoadResult(engine: EditorEngine, result: SceneLoadResult): Promise<boolean> {
  const doc = result.doc as { root?: JsonRecord | null; settings?: JsonRecord };
  const rootJson = doc.root ?? null;
  if (!rootJson || (rootJson as { type?: string }).type === "empty") return false;
  // 装载前预取全部材质/模型引用：节点入图即渲染到正确外观（避免先默认后跳变）；
  // 材质引用的着色器与扩展着色器随材质一并预取
  if (result.materialRefs.length) await engine.preloadMaterials(result.materialRefs);
  if (result.modelRefs.length) await engine.models.preload(result.modelRefs);
  engine.applySceneDocRoot(rootJson);
  engine.graph.history.update(result.history);
  return true;
}

/** 打开/切换项目内 .scene 资产：后端 scene_open 重装会话 + 镜像重建（无需重进编辑器） */
export async function reloadEditorScene(root: string, rel: string): Promise<void> {
  const store = getEditorStore();
  const engine = store.engine;
  if (!store.state.mounted || engine.isDisposed()) return;
  try {
    const result = await sceneApi.open(root, rel);
    if (engine.isDisposed()) return;
    const ok = await applySceneLoadResult(engine, result);
    if (!ok && !engine.isDisposed()) {
      const fallback = await sceneApi.loadDoc(
        buildStarterSceneDoc(engine.factory),
        root,
        rel,
      );
      if (!engine.isDisposed()) await applySceneLoadResult(engine, fallback);
    }
    store.markSaved();
    // 切换场景后回到场景编辑视图：若当前处于预览/脚本工作台，自动关闭（预览面板随之卸载并停服）
    if (store.state.viewMode !== "scene") store.setViewMode("scene");
    logStore.log("info", "场景已切换", "engine");
  } catch (e) {
    logStore.log("error", `打开场景失败: ${e}`, "engine");
  }
}

/** 销毁编辑器：清空挂载任务 → 引擎销毁并重建标记（store 侧重置单例）→ 关闭后端会话 */
export function disposeEditor(): void {
  mountTask = null;
  resetEditorEngine();
  // 后端会话一并关闭（清空权威图与历史；下次进入编辑器重新 scene_open）
  void sceneApi.close().catch(() => {});
}
