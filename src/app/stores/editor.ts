import { computed, readonly, reactive } from "vue";
import { EditorEngine } from "../../framework/engine/EditorEngine";
import type { Node } from "../../framework/prototype/Node";
import { logStore } from "./log";

export type ViewMode = "scene" | "layout" | "preview" | "script";

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

/**
 * 应用层状态桥：让框架引擎的事件（graph / selection / gizmo / history）
 * 驱动一份最小 reactive 快照，所有写路径仍走 engine 暴露的命令 API。
 * 引擎的挂载 / 场景装载 / 首页交接 / dispose 生命周期编排在
 * src/app/services/editorService.ts（store 只保留状态与引擎接线）。
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
  engine.events.on("shader:changed", bump);
  engine.events.on("model:changed", bump);
  engine.events.on("animation:changed", bump);
  engine.events.on("audio:changed", bump);
  engine.events.on("physics:changed", bump);
  engine.events.on("particles:changed", bump);
  engine.history.events.on("changed", bump);

  // 脏标记：编辑器有改动（场景图/材质/撤销重做）→ 保存按钮标记 + 关闭提醒
  engine.events.on("graph:changed", () => {
    if (state.mounted) state.dirty = true;
  });
  engine.events.on("material:changed", () => {
    if (state.mounted) state.dirty = true;
  });
  // 着色器源码保存 → 材质外观随之变化，同样计入未保存改动
  engine.events.on("shader:changed", () => {
    if (state.mounted) state.dirty = true;
  });
  // 着色器编译失败（three 的程序报错）→ 编辑器控制台（只接摘要，避免刷屏）
  engine.events.on("shader:error", ({ message }) => {
    logStore.log("error", `着色器编译失败: ${message}`, "engine");
  });
  engine.history.events.on("changed", () => {
    if (state.mounted) state.dirty = true;
  });

  // 选中 UI 节点（画布/Widget）→ 自动切到布局视图：场景视图不显示 UI，
  // 选中即视为进入 UI 编辑（预览/脚本工作台激活时不抢焦点）
  engine.events.on("select:changed", () => {
    if (state.viewMode !== "scene") return;
    const id = engine.selectedId;
    if (!id) return;
    const node = engine.graph.get(id);
    if (node && node.typeKey.startsWith("ui")) applyViewMode("layout");
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

  /** 视图模式落地：布局/场景共用引擎编辑渲染路径，差异只在 UI 画布显隐 */
  function applyViewMode(mode: ViewMode): void {
    if (mode === "scene" || mode === "layout") {
      engine.setViewMode("scene");
      engine.setRenderingActive(true);
      engine.setUIViewVisible(mode === "layout");
    } else {
      // 预览/脚本工作台由中央区域独立面板接管，暂停后台渲染省资源
      engine.setRenderingActive(false);
    }
    state.viewMode = mode;
  }

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
      applyViewMode(mode);
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

/**
 * 销毁引擎单例并清空（仅供 editorService.disposeEditor 调用）：
 * 回到首页后下次进入编辑器重新构造引擎。dispose 幂等且容错——
 * 引擎仍在异步 mount 中也安全（跳过未初始化的模块）。
 */
export function resetEditorEngine(): void {
  if (singleton) {
    singleton.engine.dispose();
    singleton = null;
  }
}
