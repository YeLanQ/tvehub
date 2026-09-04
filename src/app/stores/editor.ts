import { computed, readonly, reactive } from "vue";
import { EditorEngine } from "../../framework/engine/EditorEngine";
import { setupStarterScene } from "../../framework/engine/starterScene";
import { loadSceneFromJson } from "../../framework/engine/loadScene";
import type { Node } from "../../framework/prototype/Node";
import { logStore } from "./log";

export interface EditorStore {
  engine: EditorEngine;
  revision: () => number;
  nodes: () => Node[];
  nodeById: (id: string | null | undefined) => Node | undefined;
  childrenOf: (id: string) => Node[];
  markMounted: () => void;
  state: Readonly<{
    selectedId: string | null;
    gizmoMode: "translate" | "rotate" | "scale";
    gizmoSpace: "local" | "world";
    canUndo: boolean;
    canRedo: boolean;
    undoLabel: string | null;
    redoLabel: string | null;
    historyDepth: number;
    historyLabels: string[];
    mounted: boolean;
  }>;
}

let singleton: EditorStore | null = null;

/**
 * 应用层状态桥接：让框架引擎的事件（graph / selection / gizmo / history）
 * 驱动一份最小 reactive 快照，所有写路径仍走 engine 暴露的命令 API。
 */
export function getEditorStore(): EditorStore {
  if (singleton) return singleton;
  const engine = new EditorEngine();

  const state = reactive({
    selectedId: null as string | null,
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
  });

  const bump = (): void => {
    state.selectedId = engine.selectedId;
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
  engine.history.events.on("changed", bump);

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
    markMounted: () => {
      state.mounted = true;
    },
  };
  singleton = store;
  return store;
}

export function mountEditor(container: HTMLElement, sceneJson?: string | null): void {
  const store = getEditorStore() as EditorStore & { markMounted: () => void };
  if (store.state.mounted) return;
  store.engine.mount(container);
  if (sceneJson) loadSceneFromJson(store.engine, sceneJson);
  else setupStarterScene(store.engine);
  store.markMounted();
  logStore.log("info", "编辑器已就绪", "engine");
}

export function disposeEditor(): void {
  if (!singleton) return;
  singleton.engine.dispose();
  singleton = null;
}
