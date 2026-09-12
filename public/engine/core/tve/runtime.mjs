// ---------------------------------------------------------------------------
// 运行时宿主接线：installRuntime / getEntity / resolveNodeEntity /
// registerComponent / registerScriptClass / resolveScriptClass / resolveScriptInstance
// ---------------------------------------------------------------------------
import { resetTweens } from "../tween.mjs";
import { state, registry, normalizeScriptPath } from "./state.mjs";
import { Entity, getEntity } from "./entity.mjs";
import { installInputListeners } from "./input.mjs";

/** 按节点 id 解析场景实体（host 注册表；节点引用属性的运行期求值） */
export function resolveNodeEntity(nodeId) {
  if (!state.host || typeof nodeId !== "string" || !nodeId) return null;
  const entry = (state.host.registry || []).find((r) => r.json && r.json.id === nodeId);
  return entry ? getEntity(entry.obj) : null;
}

/** 宿主注册组件实例（getComponent 查询用；scriptRel 为脚本源路径） */
export function registerComponent(nodeId, instance, scriptRel) {
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

/** 脚本类注册（宿主在脚本模块加载后调用；路径与类名双键，类名先到先得） */
export function registerScriptClass(srcRel, klass) {
  if (typeof srcRel !== "string" || !srcRel || typeof klass !== "function") return;
  state.scriptClassByPath.set(srcRel, klass);
  if (klass.name && !state.scriptClassByName.has(klass.name)) {
    state.scriptClassByName.set(klass.name, klass);
  }
}

/** 按脚本类查找注册表中的类：token = 类（原样）/ 源路径 / 类名；未命中 null */
export function resolveScriptClass(token) {
  if (typeof token === "function") return { klass: token, srcRel: "" };
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
export function resolveScriptInstance(nodeId, token) {
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
export function installRuntime(api) {
  state.host = api;
  state.entityByObj.clear();
  state.componentsByNode.clear();
  state.builtinByNode.clear();
  state.scriptClassByPath.clear();
  state.scriptClassByName.clear();
  resetTweens();
  installInputListeners();
}

export { Entity, getEntity };