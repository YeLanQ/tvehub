// ---------------------------------------------------------------------------
// 场景图窗口 store（模块级 reactive 单例，与项目 store 惯例一致）：
// 场景图是"另外的编辑模式"——把层级实体拖入画布生成原型卡片（按节点类型/组件
// 暴露属性），用匹配节点按标签/类型批量圈定目标，用原子操作节点定义预览运行时
// 执行的行为（不回写编辑器场景）。
//
// - 项目交接（Hub「打开场景图」→ 统一窗口交接 window:project-open 事件）与资产清单；
// - 场景会话按窗口隔离（后端会话表按 webview 标签分键）：本窗口默认打开
//   项目配置的主场景（空则兜底），可在资产面板双击场景切换；层级/实体索引
//   只反映本窗口会话，与编辑器窗口互不干扰；
// - 场景实体索引：sceneApi.doc() 遍历为扁平实体表（原型卡片实时属性/匹配求值）；
// - 图会话：随场景自动持久化到 graph/ 目录（与 assets/src 同级），
//   防抖自动保存；预览导出时随产物注入（script-graph.json）由运行时解释执行；
// - 画布桥：GraphCanvas 挂载时注入（拖入原型/建操作/剪贴板/会话快照 undo）。
// ---------------------------------------------------------------------------

import { reactive } from "vue";
import { api } from "../lib/api";
import { sceneApi, type HierarchyRowDto } from "../lib/scene-api";
import { getAssetsStore } from "../app/stores/assets";
import { getGraphBootStore } from "./boot-loading";
import { fetchSceneEntities, type SceneEntity } from "./lib/scene-index";
import { parseScriptClassMeta, type ScriptPropDef } from "../app/lib/script-compile";
import {
  emptyGraphDoc,
  isGraphDoc,
  listGraphModules,
  moduleOfNodeType,
  normalizeGraphDoc,
  nextGraphVariableId,
  nextCustomNodeDefId,
  registerCustomNodeDefs,
  graphSidecarRel,
  GRAPH_FORMAT_VERSION,
  type GComment,
  type GCustomNodeDef,
  type GModuleRef,
  type GNode,
  type GVariable,
  type GVarDataType,
  type ScriptGraphDoc,
} from "../framework/graph";
import { toast, type ToastLevel } from "../ui-kit/composables/toast";

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

  /** 场景 → 场景图文件相对路径（graph/ 目录，与 assets/src 同级；.graph 后缀） */
  function sidecarRel(sceneRel: string): string {
    return graphSidecarRel(sceneRel);
  }

interface GraphWindowStore {
  readonly degraded: boolean;
  readonly ready: boolean;
  readonly root: string | null;
  readonly projectName: string;
  readonly snapToGrid: boolean;
  readonly centerMode: "graph" | "preview";
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
  /** 图变量表（var.get/var.set 引用） */
  readonly graphVariables: GVariable[];
  /** 自定义节点定义表（用户可扩展节点类型） */
  readonly graphCustomNodes: GCustomNodeDef[];
  canvas: GraphCanvasBridge | null;

  applyProject(root: string, name: string): Promise<void>;
  markDegraded(): void;
  markGraphDirty(): void;
  setSelection(id: string | null, isComment: boolean): void;
  toggleSnap(): void;
  setCenterMode(mode: "graph" | "preview"): void;
  setCanvas(bridge: GraphCanvasBridge | null): void;
  /** 打开场景资产（切当前场景；层级/实体索引/对应场景的场景图侧车随之切换） */
  openScene(rel: string): Promise<void>;
  ensureSceneSession(): Promise<void>;
  refreshHierarchy(): Promise<void>;
  setHierarchySearch(search: string): Promise<void>;
  handleFsChanged(paths: string[]): Promise<void>;
  askText(title: string, label: string, value?: string): Promise<string | null>;
  askConfirm(title: string, label: string, danger?: boolean): Promise<boolean>;
  /** 气泡提示（统一走 ui-kit 全局气泡，level 决定配色） */
  showToast(text: string, level?: ToastLevel): void;
  /** 卸载前冲刷未落盘的图会话 */
  flushGraph(): Promise<void>;
  /** 当前会话 → 带 formatVersion/模块指纹的完整导出文档（预览导出与侧车同源） */
  stampedExportDoc(): ScriptGraphDoc;
  /** 添加图变量 */
  addVariable(): void;
  /** 重命名图变量 */
  renameVariable(id: string, name: string): void;
  /** 删除图变量（同时清理引用该变量的节点 varId） */
  deleteVariable(id: string): void;
  /** 改图变量类型（同时修正初始值） */
  setVariableType(id: string, dataType: GVarDataType): void;
  /** 改图变量初始值 */
  setVariableValue(id: string, value: number | boolean | string): void;
  /** 添加自定义节点定义 */
  addCustomNodeDef(): void;
  /** 更新自定义节点定义 */
  updateCustomNodeDef(id: string, patch: Partial<GCustomNodeDef>): void;
  /** 删除自定义节点定义（同时清理引用该类型的节点） */
  deleteCustomNodeDef(id: string): void;
  /** 脚本 @property schema 懒解析（原型卡脚本卡用；AST 解析不执行用户代码） */
  propSchemaFor(rel: string): Promise<ScriptPropDef[] | null>;
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
    graphVariables: [] as GVariable[],
    graphCustomNodes: [] as GCustomNodeDef[],
  });

  let sceneWatchInstalled = false;
  let sceneDebounce: ReturnType<typeof setTimeout> | null = null;
  /** 脚本 @property schema 解析缓存（rel → 进行中/已完成的解析 Promise） */
  const propSchemaCache = new Map<string, Promise<ScriptPropDef[] | null>>();
  let sceneEnsureInFlight: Promise<void> | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let sceneToken = 0; // 换项目/换场景令牌：过期索引/侧车读取丢弃

  /** 会话图（画布权威；store 持有引用供侧车保存与预览导出） */
  let graphDoc: ScriptGraphDoc = { nodes: [], edges: [], comments: [] };

  function showToastNow(text: string, level: ToastLevel = "info"): void {
    toast(level, text);
  }

  /** 图节点引用的模块指纹（注册表归属快照；装载方据此校验模块可用性） */
  function docModuleRefs(doc: ScriptGraphDoc): GModuleRef[] {
    const versions = new Map(listGraphModules().map((m) => [m.id, m.version]));
    const used = new Set<string>();
    for (const n of doc.nodes) {
      const m = moduleOfNodeType(n.type);
      if (m) used.add(m);
    }
    return [...used].sort().map((id) => ({ id, version: versions.get(id) ?? 1 }));
  }

  /** 当前会话 → 带格式版本/模块指纹的完整导出文档（侧车落盘与预览导出共用） */
  function stampedExportDoc(): ScriptGraphDoc {
    const canvasDoc = store.canvas?.serializeDoc() ?? graphDoc;
    graphDoc = { ...canvasDoc, variables: state.graphVariables, customNodes: state.graphCustomNodes };
    return {
      ...graphDoc,
      formatVersion: GRAPH_FORMAT_VERSION,
      modules: docModuleRefs(graphDoc),
    };
  }

  /** 会话图落盘（graph/ 目录；与 assets/src 同级） */
  async function writeSidecar(): Promise<void> {
    const root = state.root;
    if (!root) return;
    try {
      const out = stampedExportDoc();
      await api.writeText(root, sidecarRel(state.sceneRel), JSON.stringify(out, null, 2));
      state.graphDirty = false;
      state.lastSavedAt = new Date().toLocaleTimeString();
    } catch (e) {
      showToastNow(`场景图自动保存失败: ${e}`, "err");
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
      showToastNow(`场景会话不可用（项目可能还没有场景）: ${e}`, "warn");
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
    get graphVariables() {
      return state.graphVariables;
    },
    get graphCustomNodes() {
      return state.graphCustomNodes;
    },
    canvas: null,

    async applyProject(root, name) {
      // 同一项目重复交接幂等；换项目则重置会话（场景与实体 id 都随之变化）
      if (state.root === root && state.ready) {
        // 蒙版可能因窗口关闭事件处于 standby 态，项目已就绪直接揭幕
        const boot = getGraphBootStore();
        if (boot.state.phase === "standby") boot.reveal();
        return;
      }
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
      state.graphVariables = [];
      state.graphCustomNodes = [];
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
        // 装载本场景的场景图侧车（不存在即空白工作板）
        try {
          const text = await api.readText(root, sidecarRel(state.sceneRel));
          if (token !== sceneToken) return;
          const parsed = JSON.parse(text) as unknown;
          graphDoc = isGraphDoc(parsed) ? normalizeGraphDoc(parsed) : { nodes: [], edges: [], comments: [] };
        } catch {
          graphDoc = { nodes: [], edges: [], comments: [] };
        }
        state.graphVariables = graphDoc.variables ?? [];
        state.graphCustomNodes = graphDoc.customNodes ?? [];
        registerCustomNodeDefs(state.graphCustomNodes);
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
      // 桥接晚于装载完成时（页面重载后画布后挂载），补载已装载的图文档
      if (bridge && graphDoc.nodes.length) bridge.loadDoc(graphDoc);
    },

    /** 打开场景资产：scene_open 切当前场景（会话唯一，项目级当前场景），
     *  层级/实体索引刷新并装载该场景的场景图侧车 */
    async openScene(rel) {
      const root = state.root;
      if (!root || !rel.toLowerCase().endsWith(".scene") || rel === state.sceneRel) return;
      const token = ++sceneToken;
      try {
        await sceneApi.open(root, rel);
      } catch (e) {
        showToastNow(`打开场景失败: ${e}`, "err");
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
      // 装载该场景的场景图侧车（不存在即空白工作板）
      try {
        const text = await api.readText(root, sidecarRel(rel));
        graphDoc = isGraphDoc(JSON.parse(text) as unknown)
          ? normalizeGraphDoc(JSON.parse(text))
          : emptyGraphDoc();
      } catch {
        graphDoc = emptyGraphDoc();
      }
      state.graphVariables = graphDoc.variables ?? [];
      state.graphCustomNodes = graphDoc.customNodes ?? [];
      registerCustomNodeDefs(state.graphCustomNodes);
      store.canvas?.loadDoc(graphDoc);
      showToastNow(`已打开场景 ${rel}`, "ok");
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

    showToast(text, level = "info") {
      showToastNow(text, level);
    },

    async flushGraph() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      if (state.graphDirty) await writeSidecar();
    },

    stampedExportDoc() {
      return stampedExportDoc();
    },

    addVariable() {
      const dummy = { nodes: [], edges: [], comments: [], variables: state.graphVariables };
      const id = nextGraphVariableId(dummy);
      const existing = state.graphVariables;
      let name = `var${existing.length + 1}`;
      let i = 1;
      while (existing.some((v) => v.name === name)) name = `var${existing.length + ++i}`;
      state.graphVariables.push({ id, name, dataType: "number", value: 0 });
      store.markGraphDirty();
    },

    renameVariable(id, name) {
      const v = state.graphVariables.find((x) => x.id === id);
      if (!v) return;
      const trimmed = name.trim().slice(0, 64);
      if (!trimmed) return;
      v.name = trimmed;
      store.markGraphDirty();
    },

    deleteVariable(id) {
      const idx = state.graphVariables.findIndex((x) => x.id === id);
      if (idx < 0) return;
      state.graphVariables.splice(idx, 1);
      // 清理引用该变量的节点 varId（画布上 var.get/var.set 节点）
      const doc = store.canvas?.serializeDoc();
      if (doc) {
        for (const n of doc.nodes) {
          if (n.varId === id) n.varId = undefined;
        }
        store.canvas?.loadDoc(doc);
      }
      store.markGraphDirty();
    },

    setVariableType(id, dataType) {
      const v = state.graphVariables.find((x) => x.id === id);
      if (!v) return;
      v.dataType = dataType;
      // 修正初始值
      if (dataType === "number") v.value = typeof v.value === "number" ? v.value : 0;
      else if (dataType === "boolean") v.value = v.value === true;
      else v.value = String(v.value);
      store.markGraphDirty();
    },

    setVariableValue(id, value) {
      const v = state.graphVariables.find((x) => x.id === id);
      if (!v) return;
      v.value = value;
      store.markGraphDirty();
    },

    addCustomNodeDef() {
      const dummy = { nodes: [], edges: [], comments: [], customNodes: state.graphCustomNodes };
      const id = nextCustomNodeDefId(dummy);
      const existing = state.graphCustomNodes;
      let typeName = `custom.node${existing.length + 1}`;
      let i = 1;
      while (existing.some((d) => d.type === typeName)) typeName = `custom.node${existing.length + ++i}`;
      const def: GCustomNodeDef = {
        id,
        type: typeName,
        label: `自定义节点 ${existing.length + 1}`,
        desc: "",
        color: "#4ec9b0",
        inputs: [{ id: "a", label: "A", dataType: "number" }],
        outputs: [{ id: "result", label: "结果", dataType: "number" }],
        fields: [],
        expressions: { result: "a" },
      };
      state.graphCustomNodes.push(def);
      registerCustomNodeDefs(state.graphCustomNodes);
      store.markGraphDirty();
    },

    updateCustomNodeDef(id, patch) {
      const d = state.graphCustomNodes.find((x) => x.id === id);
      if (!d) return;
      Object.assign(d, patch);
      registerCustomNodeDefs(state.graphCustomNodes);
      store.markGraphDirty();
    },

    deleteCustomNodeDef(id) {
      const idx = state.graphCustomNodes.findIndex((x) => x.id === id);
      if (idx < 0) return;
      const def = state.graphCustomNodes[idx];
      state.graphCustomNodes.splice(idx, 1);
      registerCustomNodeDefs(state.graphCustomNodes);
      // 清理引用该类型的节点
      const doc = store.canvas?.serializeDoc();
      if (doc) {
        doc.nodes = doc.nodes.filter((n) => n.type !== def.type);
        store.canvas?.loadDoc(doc);
      }
      store.markGraphDirty();
    },

    propSchemaFor(rel) {
      let p = propSchemaCache.get(rel);
      if (!p) {
        const root = state.root;
        p = root
          ? api
              .readText(root, rel)
              .then((src) =>
                src == null
                  ? null
                  : parseScriptClassMeta(src)
                      .then((m: { props: ScriptPropDef[] | null }) => m.props)
                      .catch(() => null),
              )
              .catch(() => null)
          : Promise.resolve(null);
        propSchemaCache.set(rel, p);
      }
      return p;
    },
  };

  /** 场景变更订阅（会话按 (root,rel) 复合键分：只应用本窗口当前项目当前场景的事件——
   *  编辑器窗口对同一场景的修改实时同步到这里） */
  function installSceneWatch(): void {
    if (sceneWatchInstalled) return;
    sceneWatchInstalled = true;
    void sceneApi.subscribe((e) => {
      if (!state.root || e.root !== state.root || e.rel !== state.sceneRel) return;
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
