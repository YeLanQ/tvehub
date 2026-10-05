// ---------------------------------------------------------------------------
// 运行时宿主接线：installRuntime / getEntity / resolveNodeEntity /
// registerComponent / registerScriptClass / resolveScriptClass / resolveScriptInstance
// ---------------------------------------------------------------------------
import { resetTweens } from "../tween";
import { state, normalizeScriptPath } from "./state";
import type { PointerCanvas, ScriptInstance, ScriptKlass, TveHost } from "./state";
import { Entity, getEntity } from "./entity";
import { installInputListeners } from "./input";

/**
 * installRuntime 装配入参（scripts.ts createScripts 装配点传入；子系统控制面
 * 以宽类型 object 声明，消费面视图见 TveHost）。
 */
export interface TveRuntimeInstall {
  registry: { json: Record<string, unknown>; obj: object }[];
  rootObj: object | null;
  canvas: PointerCanvas | null;
  animations: object | null;
  audios: object | null;
  physics: { drainCollisions?(): unknown[] } | null;
  clipAnims: object | null;
  particles: object | null;
  terrains: object | null;
  ui: object | null;
  logic: object | null;
  camera: {
    screenToRay(screenX: number, screenY: number): { origin: object; direction: object } | null;
  } | null;
  scripts: {
    spawn(entity: { id: string }, tokenOrClass: unknown, props?: unknown): Record<string, unknown> | null;
  };
}

/** 按节点 id 解析场景实体（host 注册表；节点引用属性的运行期求值） */
export function resolveNodeEntity(nodeId: string): Entity | null {
  if (!state.host || typeof nodeId !== "string" || !nodeId) return null;
  const entry = (state.host.registry || []).find((r) => r.json && r.json.id === nodeId);
  return entry ? getEntity(entry.obj) : null;
}

/** 宿主注册组件实例（getComponent 查询用；scriptRel 为脚本源路径） */
export function registerComponent(nodeId: string, instance: ScriptInstance, scriptRel: string): void {
  if (instance && typeof scriptRel === "string" && scriptRel) {
    Object.defineProperty(instance, "__tveScript", {
      value: scriptRel,
      configurable: true,
      writable: true,
    });
  }
  let list = state.componentsByNode.get(nodeId);
  if (!list) {
    list = [];
    state.componentsByNode.set(nodeId, list);
  }
  list.push(instance);
}

// entity.mjs 的 getComponent(类名字符串) 经 state 槽位调用本函数
//（与 component-registry.mjs 的 builtinTypeKeyOf 等接线同一模式）——
// 漏接线会让按脚本类名/源路径查找组件永远返回 null
state.resolveScriptInstance = resolveScriptInstance;

/** 脚本类注册（宿主在脚本模块加载后调用；路径与类名双键，类名先到先得） */
export function registerScriptClass(srcRel: string, klass: ScriptKlass): void {
  if (typeof srcRel !== "string" || !srcRel || typeof klass !== "function") return;
  state.scriptClassByPath.set(srcRel, klass);
  if (klass.name && !state.scriptClassByName.has(klass.name)) {
    state.scriptClassByName.set(klass.name, klass);
  }
}

/** 按脚本类查找注册表中的类：token = 类（原样）/ 源路径 / 类名；未命中 null */
export function resolveScriptClass(token: unknown): { klass: ScriptKlass; srcRel: string } | null {
  if (typeof token === "function") {
    // 断言安全：函数 token 即脚本类本身（含构造签名），原样返回
    return { klass: token as ScriptKlass, srcRel: "" };
  }
  if (typeof token !== "string" || !token) return null;
  if (token.includes("/") || /\.(ts|js)$/i.test(token)) {
    const p = normalizeScriptPath(token);
    const klass = state.scriptClassByPath.get(p);
    return klass ? { klass, srcRel: p } : null;
  }
  const klass = state.scriptClassByName.get(token);
  return klass ? { klass, srcRel: "" } : null;
}

/** 实体上按脚本源路径 / 脚本类名查找已挂载的脚本组件实例（未挂载 null） */
export function resolveScriptInstance(nodeId: string, token: string): ScriptInstance | null {
  const list = state.componentsByNode.get(nodeId);
  if (!list || typeof token !== "string" || !token) return null;
  if (token.includes("/") || /\.(ts|js)$/i.test(token)) {
    const p = normalizeScriptPath(token);
    return list.find((c) => c.__tveScript === p) ?? null;
  }
  const byName = list.find((c) => c.constructor && c.constructor.name === token);
  if (byName) return byName;
  const klass = state.scriptClassByName.get(token);
  return klass ? list.find((c) => c instanceof klass) ?? null : null;
}

/** 安装运行时宿主（scripts.mjs 在实例化脚本前调用一次） */
export function installRuntime(api: TveRuntimeInstall): void {
  // 断言安全：装配点传入的子系统控制面为 object 宽类型，消费面视图 TveHost
  // 的各成员由 createScripts 注入的真实后端逐一满足，仅在接线处统一收窄
  state.host = api as TveHost;
  state.entityByObj.clear();
  state.componentsByNode.clear();
  state.builtinByNode.clear();
  state.scriptClassByPath.clear();
  state.scriptClassByName.clear();
  resetTweens();
  installInputListeners();
}

export { Entity, getEntity };
