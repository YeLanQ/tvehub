import { computed, readonly, reactive } from "vue";
import { EditorEngine } from "../../framework/engine/EditorEngine";
import { buildStarterSceneDoc } from "../../framework/engine/starterScene";
import { DEFAULT_MATERIAL_REL } from "../../framework/material";
import type { Node } from "../../framework/prototype/Node";
import type { JsonRecord } from "../../framework/prototype/types";
import { assetUrl, fetchAssetBinary } from "../../lib/asset-url";
import { sceneApi, type SceneLoadResult } from "../../lib/scene-api";
import { loadMaterialDoc } from "../lib/materials";
import { logStore } from "./log";
import { getProjectStore } from "./project";

export type ViewMode = "scene" | "preview" | "script";

export interface EditorStore {
  engine: EditorEngine;
  revision: () => number;
  nodes: () => Node[];
  nodeById: (id: string | null | undefined) => Node | undefined;
  childrenOf: (id: string) => Node[];
  markMounted: () => void;
  /** 编辑器是否有未保存修改（保存按钮标记 / 关闭提醒用） */
  dirty: () => boolean;
  /** 场景已保存/已切换 → 清除脏标记 */
  markSaved: () => void;
  setViewMode: (mode: ViewMode) => void;
  state: Readonly<{
    selectedId: string | null;
    selectionIds: string[];
    viewMode: ViewMode;
    gizmoMode: "translate" | "rotate" | "scale";
    gizmoSpace: "local" | "world";
    canUndo: boolean;
    canRedo: boolean;
    undoLabel: string | null;
    redoLabel: string | null;
    historyDepth: number;
    historyLabels: string[];
    mounted: boolean;
    dirty: boolean;
  }>;
}

let singleton: EditorStore | null = null;
/** 挂载任务去重：引擎挂载是异步的（渲染后端可能动态加载），并发调用共享同一任务 */
let mountTask: Promise<void> | null = null;

/**
 * 应用层状态桥接：让框架引擎的事件（graph / selection / gizmo / history）
 * 驱动一份最小 reactive 快照，所有写路径仍走 engine 暴露的命令 API。
 */
export function getEditorStore(): EditorStore {
  if (singleton) return singleton;
  const engine = new EditorEngine();

  const state = reactive({
    selectedId: null as string | null,
    selectionIds: [] as string[],
    viewMode: "scene" as ViewMode,
    gizmoMode: "translate" as EditorStore["state"]["gizmoMode"],
    gizmoSpace: "local" as EditorStore["state"]["gizmoSpace"],
    canUndo: false,
    canRedo: false,
    undoLabel: null as string | null,
    redoLabel: null as string | null,
    historyDepth: 0,
    historyLabels: [] as string[],
    mounted: false,
    revision: 0,
    dirty: false,
  });

  const bump = (): void => {
    state.selectedId = engine.selectedId;
    state.selectionIds = engine.selectionIds;
    state.gizmoMode = engine.gizmoMode;
    state.gizmoSpace = engine.gizmoSpace;
    state.canUndo = engine.history.canUndo;
    state.canRedo = engine.history.canRedo;
    state.undoLabel = engine.history.peekUndoLabel();
    state.redoLabel = engine.history.peekRedoLabel();
    state.historyDepth = engine.history.depth;
    state.historyLabels = engine.history.listLabels();
    state.revision += 1;
  };

  engine.events.on("graph:changed", bump);
  engine.events.on("select:changed", bump);
  engine.events.on("gizmo:state", bump);
  engine.events.on("material:changed", bump);
  engine.events.on("model:changed", bump);
  engine.events.on("animation:changed", bump);
  engine.history.events.on("changed", bump);

  // 脏标记：编辑器有改动（场景图/材质/撤销重做）→ 保存按钮标记 + 关闭提醒
  engine.events.on("graph:changed", () => {
    if (state.mounted) state.dirty = true;
  });
  engine.events.on("material:changed", () => {
    if (state.mounted) state.dirty = true;
  });
  engine.history.events.on("changed", () => {
    if (state.mounted) state.dirty = true;
  });

  // 场景图变化 → 控制台日志（框架层不依赖 app，日志桥接只在 app 层）
  engine.events.on("graph:changed", (c) => {
    const node = engine.graph.get(c.nodeId);
    const name = node?.name ?? c.nodeId;
    switch (c.kind) {
      case "add":
        logStore.log("success", `创建节点 ${name}`, "engine");
        break;
      case "remove":
        logStore.log("warn", `删除节点 ${name}`, "engine");
        break;
      case "reparent":
        logStore.log("info", `调整节点层级 ${name}`, "engine");
        break;
      case "rename":
        logStore.log("info", `重命名节点 ${name}`, "engine");
        break;
      default:
        break;
    }
  });

  const nodes = computed(() => {
    state.revision;
    return engine.graph.all();
  });
  const revision = computed(() => state.revision);

  const store: EditorStore = {
    engine,
    revision: () => revision.value,
    nodes: () => nodes.value,
    nodeById: (id) => {
      revision.value;
      return id ? engine.graph.get(id) : undefined;
    },
    childrenOf: (id) => {
      revision.value;
      return engine.graph.childrenOf(id);
    },
    state: readonly(state) as unknown as EditorStore["state"],
    setViewMode: (mode) => {
      // 预览页签由中央区域的独立“网页预览”面板（WebPreviewPanel iframe）接管，
      // 编辑器画布不再做引擎内相机预览渲染；脚本/预览期间暂停后台渲染省资源。
      if (mode === "scene") {
        engine.setViewMode("scene");
        engine.setRenderingActive(true);
      } else {
        engine.setRenderingActive(false);
      }
      state.viewMode = mode;
    },
    markMounted: () => {
      state.mounted = true;
    },
    dirty: () => state.dirty,
    markSaved: () => {
      state.dirty = false;
    },
  };
  singleton = store;
  return store;
}

export function mountEditor(container: HTMLElement): Promise<void> {
  const store = getEditorStore() as EditorStore & { markMounted: () => void };
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
      // 材质资产来源：后端 material_read（internal/项目路由 + .mat 解析均在 Rust）
      engine.materials.setFetcher(root ? (rel) => loadMaterialDoc(root, rel) : null);
      // 贴图来源：asset:// 协议直读（internal/… 与项目资产统一走协议 URL）
      engine.setTextureResolver(root ? (rel) => (rel ? assetUrl(rel) : null) : null);
      // 模型来源：与贴图同构（协议 URL + 按需流式外部资源，无预读）
      engine.setModelAccess(
        root
          ? {
              readBinary: (rel) => fetchAssetBinary(rel),
              urlFor: (rel) => assetUrl(rel),
            }
          : null,
      );
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
        await engine.materials.preload([DEFAULT_MATERIAL_REL]);
        if (engine.isDisposed()) return;
        const result = await sceneApi.loadDoc(
          buildStarterSceneDoc(engine.factory),
          root ?? undefined,
          sceneRel || undefined,
        );
        if (engine.isDisposed()) return;
        await applySceneLoadResult(engine, result);
      }
      store.markMounted();
      store.markSaved();
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
  const doc = result.doc as { root?: JsonRecord | null };
  const rootJson = doc.root ?? null;
  if (!rootJson || (rootJson as { type?: string }).type === "empty") return false;
  // 装载前预取全部材质/模型引用：节点入图即渲染到正确外观（避免先默认后跳变）
  if (result.materialRefs.length) await engine.materials.preload(result.materialRefs);
  if (result.modelRefs.length) await engine.models.preload(result.modelRefs);
  engine.applySceneDocRoot(rootJson);
  engine.graph.history.update(result.history);
  return true;
}

/** 打开/切换项目内 .scene 资产：后端 scene_open 重装会话 + 镜像重建（无需重进编辑器） */
export async function reloadEditorScene(root: string, rel: string): Promise<void> {
  const store = getEditorStore() as EditorStore & { markMounted: () => void };
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
    logStore.log("info", "场景已切换", "engine");
  } catch (e) {
    logStore.log("error", `打开场景失败: ${e}`, "engine");
  }
}

export function disposeEditor(): void {
  mountTask = null;
  if (!singleton) return;
  // dispose 幂等且容错：即便引擎仍在异步 mount 中也能安全销毁（跳过未初始化的模块）
  singleton.engine.dispose();
  singleton = null;
  // 后端会话一并关闭（清空权威图与历史；下次进入编辑器重新 scene_open）
  void sceneApi.close().catch(() => {});
}
