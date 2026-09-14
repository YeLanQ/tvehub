// ---------------------------------------------------------------------------
// 共享可变状态与基础工具函数（所有 tve 子模块的唯一事实来源）。
// host / 注册表 Map / 序列号 / 输入状态集中持有；组件函数经 state 注入解耦
// （entity.mjs 不直接导入 component-registry / runtime，打破循环依赖）。
// ---------------------------------------------------------------------------

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;
export const EPS = 1e-6;

/** 运行时宿主接线与全部可变状态的唯一持有处 */
export const state = {
  /** @type {import("../tve.mjs").TveHost | null} */
  host: null,
  entityByObj: new Map(),
  componentsByNode: new Map(),
  scriptClassByPath: new Map(),
  scriptClassByName: new Map(),
  builtinByNode: new Map(),
  runtimeCompSeq: 0,
  timeState: { delta: 0, elapsed: 0, frame: 0 },
  heldKeys: new Set(),
  keyDownHandlers: new Set(),
  keyUpHandlers: new Set(),
  pointerState: { x: 0, y: 0, down: false },
  pointerDownHandlers: new Set(),
  pointerUpHandlers: new Set(),
  pointerMoveHandlers: new Set(),
  inputInstalled: false,
  // 注入的组件函数（由 component-registry.mjs / runtime.mjs 设置；entity.mjs 经 state 调用）
  builtinTypeKeyOf: null,
  builtinFacadeOf: null,
  createRuntimeBuiltin: null,
  resolveScriptInstance: null,
};

export const EMPTY_REGISTRY = [];

export function registry() {
  return state.host ? state.host.registry : EMPTY_REGISTRY;
}

export function isNodeObj(obj) {
  return !!obj && typeof obj.userData?.nodeId === "string" && obj.userData.nodeId !== "";
}

export function numOr(v, fb) {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

export function nextRuntimeCompId() {
  state.runtimeCompSeq += 1;
  return `comp_rt${state.runtimeCompSeq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function nodeJsonOf(id) {
  const entry = registry().find((r) => r.json && r.json.id === id);
  return entry ? entry.json : null;
}

export function componentJsonOf(nodeJson, typeKey) {
  const comps = Array.isArray(nodeJson?.components) ? nodeJson.components : [];
  return comps.find((c) => c && c.type === typeKey && c.enabled !== false) ?? null;
}

export function pushComponentJson(nodeJson, comp) {
  if (!Array.isArray(nodeJson.components)) nodeJson.components = [];
  nodeJson.components.push(comp);
}

export function normalizeScriptPath(token) {
  let p = String(token).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\.js$/i, ".ts");
  if (!p.startsWith("src/")) p = "src/" + p;
  return p;
}

export function formatArgs(args) {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

/** 节点 id → 脚本组件实例列表（宿主注册；getComponent 用） */
export function scriptComponentsOf(nodeId) {
  return state.componentsByNode.get(nodeId);
}