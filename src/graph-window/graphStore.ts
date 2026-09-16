// ---------------------------------------------------------------------------
// 脚本图窗口 store（模块级 reactive 单例，与项目 store 惯例一致）：
// 脚本图是"另外的编辑模式"——把层级实体拖入画布生成原型卡片（按节点类型/组件
// 暴露属性），用匹配节点按标签/类型批量圈定目标，用原子操作节点定义预览运行时
// 执行的行为（不回写编辑器场景）。
//
// - 项目交接（Hub「打开脚本图」→ graph:project-open 事件）与资产清单；
// - 场景会话按窗口隔离（后端会话表按 webview 标签分键）：本窗口默认打开
//   项目配置的主场景（空则兜底），可在资产面板双击场景切换；层级/实体索引
//   只反映本窗口会话，与编辑器窗口互不干扰；
// - 场景实体索引：sceneApi.doc() 遍历为扁平实体表（原型卡片实时属性/匹配求值）；
// - 图会话：随场景自动持久化到 .tve/script-graph/ 旁路（用户不感知文件），
//   防抖自动保存；预览导出时随产物注入（script-graph.json）由运行时解释执行；
// - 画布桥：GraphCanvas 挂载时注入（拖入原型/建操作/剪贴板/会话快照 undo）。
// ---------------------------------------------------------------------------

import { reactive } from "vue";
import { api } from "../lib/api";
import { sceneApi, type HierarchyRowDto } from "../lib/scene-api";
import { getAssetsStore } from "../app/stores/assets";
import { getGraphBootStore } from "./boot-loading";
import { fetchSceneEntities, type SceneEntity } from "./lib/scene-index";
import {
  emptyGraphDoc,
  isGraphDoc,
  normalizeGraphDoc,
  type GComment,
  type GNode,
  type ScriptGraphDoc,
} from "../framework/graph";

/** 画布桥：GraphCanvas 挂载时注册，宿主 UI 经此驱动画布能力 */
export interface GraphCanvasBridge {
  /** 全量载入图（节点/连线/注释框） */
  loadDoc(doc: ScriptGraphDoc): void;
  /** 当前画布状态 → 图文档 */
  serializeDoc(): ScriptGraphDoc | null;
  /** 适配视图（内容包围盒居中） */
  fitView(): void;
  undo(): void;
  redo(): void;
  /** 在下一次变更前压入会话快照（拖拽起手/字段提交前） */
  requestSnapshot(): void;
  /** 从层级拖入/双击加入：按实体生成原型节点（同实体去重） */
  addProto(entityId: string, at?: { x: number; y: number }): void;
  /** 创建匹配节点（tag|type） */
  addMatch(mode: "tag" | "type", at?: { x: number; y: number }): void;
  /** 创建操作节点（opRegistry 注册键） */
  addOp(opType: string, at?: { x: number; y: number }): void;
  /** 创建注释框 */
  addComment(at?: { x: number; y: number }): void;
  copySelection(): void;
  paste(at?: { x: number; y: number }): void;
  deleteSelection(): void;
  /** 当前选中的图节点/注释框（活动引用；检查器直接改它） */
  getSelectedNode(): GNode | null;
  getSelectedComment(): GComment | null;
}

/** 简易模态输入/确认（Tauri WebView 无可靠原生 prompt/confirm） */
export interface GraphModalState {
  open: boolean;
  title: string;
  label: string;
  value: string;
  mode: "text" | "confirm";
  danger: boolean;
  resolve: ((v: string | null) => void) | null;
}

  /** 场景 → 侧车文件相对路径（.tve 旁路，用户不感知；dot 目录不进资产/meta） */
  function sidecarRel(sceneRel: string): string {
    return `.tve/script-graph/${sceneRel.replace(/\//g, "__")}.json`;
  }

interface GraphWindowStore {
  readonly degraded: boolean;
  readonly ready: boolean;
  readonly root: string | null;
  readonly projectName: string;
  readonly snapToGrid: boolean;
  readonly centerMode: "graph" | "preview";
  readonly notice: string;
  readonly modal: GraphModalState;
  readonly hierarchy: HierarchyRowDto[];
  readonly hierarchySearch: string;
  readonly sceneRel: string;
  /** 场景实体索引（原型卡片实时属性 / 匹配求值） */
  readonly sceneEntities: SceneEntity[];
  /** 图会话（自动持久化） */
  readonly graphDirty: boolean;
  readonly lastSavedAt: string;
  readonly selectedId: string | null;
  readonly selectedIsComment: boolean;
  canvas: GraphCanvasBridge | null;

  applyProject(root: string, name: string): Promise<void>;
  markDegraded(): void;
  markGraphDirty(): void;
  setSelection(id: string | null, isComment: boolean): void;
  toggleSnap(): void;
  setCenterMode(mode: "graph" | "preview"): void;
  setCanvas(bridge: GraphCanvasBridge | null): void;
  /** 打开场景资产（切当前场景；层级/实体索引/对应场景的脚本图侧车随之切换） */
  openScene(rel: string): Promise<void>;
  ensureSceneSession(): Promise<void>;
  refreshHierarchy(): Promise<void>;
  setHierarchySearch(search: string): Promise<void>;
  handleFsChanged(paths: string[]): Promise<void>;
  askText(title: string, label: string, value?: string): Promise<string | null>;
  askConfirm(title: string, label: string, danger?: boolean): Promise<boolean>;
  showToast(text: string): void;
  /** 卸载前冲刷未落盘的图会话 */
  flushGraph(): Promise<void>;
}

let singleton: GraphWindowStore | null = null;

export function getGraphWindowStore(): GraphWindowStore {
  if (singleton) return singleton;

  const state = reactive({
    degraded: false,
    ready: false,
    root: null as string | null,
    projectName: "",
    snapToGrid: true,
    centerMode: "graph" as "graph" | "preview",
    notice: "",
    modal: {
      open: false,
      title: "",
      label: "",
      value: "",
      mode: "text" as "text" | "confirm",
      danger: false,
      resolve: null as ((v: string | null) => void) | null,
    },
    hierarchy: [] as HierarchyRowDto[],
    hierarchySearch: "",
    sceneRel: "assets/Main.scene",
    sceneEntities: [] as SceneEntity[],
    graphDirty: false,
    lastSavedAt: "",
    selectedId: null as string | null,
    selectedIsComment: false,
  });

  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  let sceneWatchInstalled = false;
  let sceneDebounce: ReturnType<typeof setTimeout> | null = null;
  let sceneEnsureInFlight: Promise<void> | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let sceneToken = 0; // 换项目/换场景令牌：过期索引/侧车读取丢弃

  /** 会话图（画布权威；store 持有引用供侧车保存与预览导出） */
  let graphDoc: ScriptGraphDoc = { nodes: [], edges: [], comments: [] };

  function showToastNow(text: string): void {
    state.notice = text;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      state.notice = "";
    }, 4000);
  }

  /** 会话图落盘（.tve 旁路；点目录不进资产面板与 .meta） */
  async function writeSidecar(): Promise<void> {
    const root = state.root;
    if (!root) return;
    try {
      await api.writeText(root, sidecarRel(state.sceneRel), JSON.stringify(graphDoc, null, 2));
      state.graphDirty = false;
      state.lastSavedAt = new Date().toLocaleTimeString();
    } catch (e) {
      showToastNow(`脚本图自动保存失败: ${e}`);
    }
  }

  function scheduleAutosave(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void writeSidecar();
    }, 600);
  }

  /** 图窗口打开自己的场景会话（窗口间会话隔离，互不冲突）：
   *  项目配置 mainScene → 第一个场景 → 默认 Main.scene */
  async function ensureSceneSessionInner(): Promise<void> {
    const root = state.root;
    if (!root) return;
    let configText: string | null = null;
    try {
      configText = await api.readText(root, "project.config.json");
    } catch {
      /* 无配置按缺省解析 */
    }
    const first = getAssetsStore()
      .assets.filter((a) => a.kind === "scene" && !a.path.endsWith("/"))
      .map((a) => a.path)
      .sort()[0];
    let rel = "assets/Main.scene";
    if (configText) {
      try {
        const cfg = JSON.parse(configText) as { mainScene?: unknown };
        const m = typeof cfg.mainScene === "string" ? cfg.mainScene.trim() : "";
        if (m && !m.startsWith("internal/") && m !== "src" && !m.startsWith("src/") && getAssetsStore().assets.some((a) => a.path === m)) {
          rel = m;
        } else if (first) {
          rel = first;
        }
      } catch {
        if (first) rel = first;
      }
    } else if (first) {
      rel = first;
    }
    state.sceneRel = rel;
    try {
      await sceneApi.open(root, rel);
      const r = await sceneApi.hierarchyRows("scene", state.hierarchySearch);
      state.hierarchy = r.rows;
    } catch (e) {
      state.hierarchy = [];
      showToastNow(`场景会话不可用（项目可能还没有场景）: ${e}`);
    }
  }

  /** 会话探测/兜底打开（重入防护） */
  async function ensureSceneSession(): Promise<void> {
    if (sceneEnsureInFlight) return sceneEnsureInFlight;
    sceneEnsureInFlight = ensureSceneSessionInner();
    try {
      await sceneEnsureInFlight;
    } finally {
      sceneEnsureInFlight = null;
    }
  }

  const store: GraphWindowStore = {
    get degraded() {
      return state.degraded;
    },
    get ready() {
      return state.ready;
    },
    get root() {
      return state.root;
    },
    get projectName() {
      return state.projectName;
    },
    get snapToGrid() {
      return state.snapToGrid;
    },
    get centerMode() {
      return state.centerMode;
    },
    get notice() {
      return state.notice;
    },
    get modal() {
      return state.modal;
    },
    get hierarchy() {
      return state.hierarchy;
    },
    get hierarchySearch() {
      return state.hierarchySearch;
    },
    get sceneRel() {
      return state.sceneRel;
    },
    get sceneEntities() {
      return state.sceneEntities;
    },
    get graphDirty() {
      return state.graphDirty;
    },
    get lastSavedAt() {
      return state.lastSavedAt;
    },
    get selectedId() {
      return state.selectedId;
    },
    get selectedIsComment() {
      return state.selectedIsComment;
    },
    canvas: null,

    async applyProject(root, name) {
      // 同一项目重复交接幂等；换项目则重置会话（场景与实体 id 都随之变化）
      if (state.root === root && state.ready) return;
      const boot = getGraphBootStore();
      boot.begin(name);
      state.root = root;
      state.projectName = name;
      state.ready = true; // 工作区就位（装载蒙版盖在上面，揭幕由 boot store 控制）
      state.sceneEntities = [];
      state.selectedId = null;
      state.hierarchy = [];
      state.centerMode = "graph";
      state.graphDirty = false;
      state.lastSavedAt = "";
      graphDoc = { nodes: [], edges: [], comments: [] };
      store.canvas?.loadDoc(graphDoc);
      installSceneWatch();
      const token = ++sceneToken;
      try {
        boot.activate("assets");
        await getAssetsStore().load(root);
        boot.complete("assets");

        boot.activate("scene");
        await ensureScene();
        if (token !== sceneToken) return;
        // 场景实体索引（原型卡片/匹配求值数据源）
        try {
          state.sceneEntities = await fetchSceneEntities();
        } catch {
          state.sceneEntities = [];
        }
        boot.complete("scene");

        boot.activate("graph");
        // 装载本场景的脚本图侧车（不存在即空白工作板）
        try {
          const text = await api.readText(root, sidecarRel(state.sceneRel));
          if (token !== sceneToken) return;
          const parsed = JSON.parse(text) as unknown;
          graphDoc = isGraphDoc(parsed) ? normalizeGraphDoc(parsed) : { nodes: [], edges: [], comments: [] };
        } catch {
          graphDoc = { nodes: [], edges: [], comments: [] };
        }
        store.canvas?.loadDoc(graphDoc);
        boot.complete("graph");
        boot.finish();
      } catch (e) {
        boot.fail(String(e));
      }
    },

    markDegraded() {
      state.degraded = true;
    },

    markGraphDirty() {
      state.graphDirty = true;
      scheduleAutosave();
    },

    setSelection(id, isComment) {
      state.selectedId = id;
      state.selectedIsComment = isComment;
    },

    toggleSnap() {
      state.snapToGrid = !state.snapToGrid;
    },

    setCenterMode(mode) {
      state.centerMode = mode;
    },

    setCanvas(bridge) {
      store.canvas = bridge;
    },

    /** 打开场景资产：scene_open 切当前场景（会话唯一，项目级当前场景），
     *  层级/实体索引刷新并装载该场景的脚本图侧车 */
    async openScene(rel) {
      const root = state.root;
      if (!root || !rel.toLowerCase().endsWith(".scene") || rel === state.sceneRel) return;
      const token = ++sceneToken;
      try {
        await sceneApi.open(root, rel);
      } catch (e) {
        showToastNow(`打开场景失败: ${e}`);
        return;
      }
      if (token !== sceneToken) return;
      state.sceneRel = rel;
      state.selectedId = null;
      await store.refreshHierarchy().catch(() => {});
      try {
        state.sceneEntities = await fetchSceneEntities();
      } catch {
        state.sceneEntities = [];
      }
      if (token !== sceneToken) return;
      // 装载该场景的脚本图侧车（不存在即空白工作板）
      try {
        const text = await api.readText(root, sidecarRel(rel));
        graphDoc = isGraphDoc(JSON.parse(text) as unknown)
          ? normalizeGraphDoc(JSON.parse(text))
          : emptyGraphDoc();
      } catch {
        graphDoc = emptyGraphDoc();
      }
      store.canvas?.loadDoc(graphDoc);
      showToastNow(`已打开场景 ${rel}`);
    },

    async ensureSceneSession() {
      await ensureScene();
    },

    async refreshHierarchy() {
      if (!state.root) return;
      try {
        const r = await sceneApi.hierarchyRows("scene", state.hierarchySearch);
        state.hierarchy = r.rows;
      } catch {
        state.hierarchy = [];
      }
    },

    async setHierarchySearch(search) {
      state.hierarchySearch = search;
      await store.refreshHierarchy();
    },

    async handleFsChanged(paths) {
      if (!state.root) return;
      await getAssetsStore().refresh();
      void paths;
    },

    askText(title, label, value = "") {
      return new Promise((resolve) => {
        state.modal = {
          open: true,
          title,
          label,
          value,
          mode: "text",
          danger: false,
          resolve: (v) => resolve(v),
        };
      });
    },

    askConfirm(title, label, danger = false) {
      return new Promise((resolve) => {
        state.modal = {
          open: true,
          title,
          label,
          value: "",
          mode: "confirm",
          danger,
          resolve: (v) => resolve(v !== null),
        };
      });
    },

    showToast(text) {
      showToastNow(text);
    },

    async flushGraph() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      if (state.graphDirty) await writeSidecar();
    },
  };

  /** 场景变更订阅（会话按场景 rel 分键：只应用本窗口当前场景的事件——
   *  编辑器窗口对同一场景的修改实时同步到这里） */
  function installSceneWatch(): void {
    if (sceneWatchInstalled) return;
    sceneWatchInstalled = true;
    void sceneApi.subscribe((e) => {
      if (!state.root || e.rel !== state.sceneRel) return;
      if (sceneDebounce) clearTimeout(sceneDebounce);
      sceneDebounce = setTimeout(() => {
        void store.refreshHierarchy().catch(() => {});
        void fetchSceneEntities()
          .then((es) => {
            state.sceneEntities = es;
          })
          .catch(() => {});
      }, 250);
    });
  }

  /** ensureScene 的令牌包装（换项目后过期结果丢弃） */
  async function ensureScene(): Promise<void> {
    await ensureSceneSession();
  }

  singleton = store;
  return store;
}
