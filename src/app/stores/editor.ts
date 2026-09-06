import { computed, readonly, reactive } from "vue";
import { EditorEngine } from "../../framework/engine/EditorEngine";
import { setupStarterScene } from "../../framework/engine/starterScene";
import { loadSceneFromJson } from "../../framework/engine/loadScene";
import { collectMeshMaterialRefs, DEFAULT_MATERIAL_REL } from "../../framework/material";
import { collectMeshModelRefs } from "../../framework/mesh";
import type { Node } from "../../framework/prototype/Node";
import { api } from "../../lib/api";
import { isInternalAsset } from "../../lib/internal-assets";
import { readMaterialText, migrateLegacySceneText } from "../lib/materials";
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

export function mountEditor(container: HTMLElement, sceneJson?: string | null): Promise<void> {
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
      // 材质资产内容来源：内置 internal/… 走内置读取；项目 assets/… 读项目文件
      engine.materials.setFetcher(root ? (rel) => readMaterialText(root, rel) : null);
      // 贴图来源：internal/… 走内置二进制读取；项目 assets/… 读项目文件
      engine.setTextureReader(
        root
          ? async (rel) =>
              isInternalAsset(rel)
                ? await api.readInternalBinary(rel).catch(() => null)
                : await api.readAssetBinary(root, rel).catch(() => null)
          : null,
      );
      // 模型来源：与贴图同构（二进制 + 同目录清单，清单直接扫盘保证新鲜）
      engine.setModelAccess(
        root
          ? {
              readBinary: async (rel) =>
                isInternalAsset(rel)
                  ? await api.readInternalBinary(rel).catch(() => null)
                  : await api.readAssetBinary(root, rel).catch(() => null),
              listDir: async (dir) => {
                try {
                  const entries = await api.scanAssets(root);
                  const prefix = dir ? `${dir}/` : "";
                  return entries
                    .filter((a) => a.kind !== "dir" && a.path.startsWith(prefix))
                    .map((a) => a.path);
                } catch {
                  return [];
                }
              },
            }
          : null,
      );
      await engine.mount(container, {
        renderer: projectStore.rendererBackend,
        antialias: projectStore.antiAliasing,
        hdrMode: projectStore.hdrMode,
      });
      // 挂载期间被销毁（如就绪前点击“关闭”返回首页）→ 不再装载场景/重建
      if (engine.isDisposed()) return;
      if (sceneJson) {
        // 旧版场景：先把内嵌材质参数迁移为项目材质资产（internal 默认无需生成）
        let text = sceneJson;
        if (root) {
          try {
            text = await migrateLegacySceneText(root, sceneJson);
          } catch (e) {
            logStore.log("warn", `旧场景材质迁移失败（按默认材质加载）: ${e}`, "engine");
          }
        }
        if (engine.isDisposed()) return;
        // 装载前预取全部材质/模型引用：节点入图即渲染到正确外观（避免先默认后跳变）
        let sceneData: unknown = null;
        try {
          sceneData = JSON.parse(text);
        } catch {
          /* 解析失败时按空引用集合处理，装载期会回退初始场景 */
        }
        const matRefs = sceneData ? collectMeshMaterialRefs(sceneData) : [];
        if (matRefs.length) await engine.materials.preload(matRefs);
        const modelRefs = sceneData ? collectMeshModelRefs(sceneData) : [];
        if (modelRefs.length) await engine.models.preload(modelRefs);
        if (engine.isDisposed()) return;
        // 空/损坏场景（含旧版 "empty" 魔法标记）解析失败时回退到初始场景，避免白屏报错
        if (!loadSceneFromJson(engine, text)) {
          setupStarterScene(engine);
        }
      } else {
        await engine.materials.preload([DEFAULT_MATERIAL_REL]);
        if (engine.isDisposed()) return;
        setupStarterScene(engine);
      }
      store.markMounted();
      store.markSaved();
      logStore.log("info", "编辑器已就绪", "engine");
    })();
  }
  return mountTask;
}

/** 打开/切换项目内 .scene 资产：把场景文本重载进已挂载的引擎（无需重进编辑器） */
export async function reloadEditorScene(root: string, text: string): Promise<void> {
  const store = getEditorStore() as EditorStore & { markMounted: () => void };
  const engine = store.engine;
  if (!store.state.mounted || engine.isDisposed()) return;
  // 旧版场景：先迁移内嵌材质 → 再预取材质 → 替换场景图
  let migrated = text;
  try {
    migrated = await migrateLegacySceneText(root, text);
  } catch (e) {
    logStore.log("warn", `旧场景材质迁移失败（按原内容加载）: ${e}`, "engine");
  }
  if (engine.isDisposed()) return;
  let matRefs: string[] = [];
  let modelRefs: string[] = [];
  try {
    const sceneData: unknown = JSON.parse(migrated);
    matRefs = collectMeshMaterialRefs(sceneData);
    modelRefs = collectMeshModelRefs(sceneData);
  } catch {
    /* 保留空引用集合 */
  }
  if (matRefs.length) await engine.materials.preload(matRefs);
  if (modelRefs.length) await engine.models.preload(modelRefs);
  if (engine.isDisposed()) return;
  loadSceneFromJson(engine, migrated);
  store.markSaved();
  logStore.log("info", "场景已切换", "engine");
}

export function disposeEditor(): void {
  mountTask = null;
  if (!singleton) return;
  // dispose 幂等且容错：即便引擎仍在异步 mount 中也能安全销毁（跳过未初始化的模块）
  singleton.engine.dispose();
  singleton = null;
}
