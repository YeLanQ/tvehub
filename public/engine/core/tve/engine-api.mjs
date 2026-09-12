// ---------------------------------------------------------------------------
// engine API：animation / audio / particles / physics / scene 控制接口
// 脚本经 engine.animation / engine.audio / engine.particles / engine.physics /
// engine.scene 调用；按实体寻址，转发到宿主后端。
// ---------------------------------------------------------------------------
import { state, numOr, registry } from "./state.mjs";
import { getEntity, deepFind } from "./entity.mjs";
import { resolveScriptInstance } from "./runtime.mjs";
import { builtinTypeKeyOf, builtinFacadeOf } from "./component-registry.mjs";

const animationApi = {
  play(entity, clip) { state.host?.animations?.play(entity?.id, clip); },
  stop(entity) { state.host?.animations?.stop(entity?.id); },
  pause(entity) { state.host?.animations?.pause(entity?.id); },
  resume(entity) { state.host?.animations?.resume(entity?.id); },
};

const audioApi = {
  play(entity) { state.host?.audios?.play(entity?.id); },
  stop(entity) { state.host?.audios?.stop(entity?.id); },
  pause(entity) { state.host?.audios?.pause(entity?.id); },
  resume(entity) { state.host?.audios?.resume(entity?.id); },
  setVolume(entity, volume) { state.host?.audios?.setVolume(entity?.id, volume); },
};

const particlesApi = {
  play(entity) { state.host?.particles?.play(entity?.id); },
  pause(entity) { state.host?.particles?.pause(entity?.id); },
  stop(entity) { state.host?.particles?.stop(entity?.id); },
  restart(entity) { state.host?.particles?.restart(entity?.id); },
  clear(entity) { state.host?.particles?.clear(entity?.id); },
  stateOf(entity) { return state.host?.particles?.infoOf(entity?.id) ?? null; },
  setSettings(entity, patch) { state.host?.particles?.updateSettings(entity?.id, patch); },
};

const physicsApi = {
  applyImpulse(entity, x, y, z) {
    state.host?.physics?.applyImpulse(entity?.id, numOr(x, 0), numOr(y, 0), numOr(z, 0));
  },
  applyForce(entity, x, y, z) {
    state.host?.physics?.applyForce(entity?.id, numOr(x, 0), numOr(y, 0), numOr(z, 0));
  },
  setLinearVelocity(entity, x, y, z) {
    state.host?.physics?.setLinearVelocity(entity?.id, numOr(x, 0), numOr(y, 0), numOr(z, 0));
  },
  setAngularVelocity(entity, x, y, z) {
    state.host?.physics?.setAngularVelocity(entity?.id, numOr(x, 0), numOr(y, 0), numOr(z, 0));
  },
  getLinearVelocity(entity) {
    return state.host?.physics?.getLinearVelocity(entity?.id) ?? null;
  },
  bodyInfo(entity) {
    return state.host?.physics?.bodyInfo(entity?.id) ?? null;
  },
  setGravityScale(entity, scale) {
    state.host?.physics?.setGravityScale(entity?.id, numOr(scale, 1));
  },
  wakeUp(entity) {
    state.host?.physics?.wakeUp(entity?.id);
  },
  setGravity(x, y, z) {
    state.host?.physics?.setGravity(numOr(x, 0), numOr(y, -9.81), numOr(z, 0));
  },
};

/** 单实体按 token 找组件：脚本类 / 脚本路径 / 类名 / 内置组件门面类 / 类型键 */
function findOnEntity(entity, token) {
  const typeKey = builtinTypeKeyOf(token);
  if (typeKey) return builtinFacadeOf(entity, typeKey);
  if (typeof token === "function") {
    const list = state.componentsByNode.get(entity.id);
    return list ? list.find((c) => c instanceof token) ?? null : null;
  }
  if (typeof token === "string") return resolveScriptInstance(entity.id, token);
  return null;
}

const sceneApi = {
  get root() {
    const rootObj = state.host && state.host.rootObj;
    return rootObj ? getEntity(rootObj) : null;
  },
  find(nameOrPath) {
    const rootObj = state.host && state.host.rootObj;
    if (!rootObj) return null;
    if (rootObj.name === nameOrPath) return getEntity(rootObj);
    const hit = deepFind(rootObj, nameOrPath);
    return hit ? getEntity(hit) : null;
  },
  findAll() {
    return registry().map((e) => getEntity(e.obj)).filter(Boolean);
  },
  findByTag(tag) {
    for (const e of registry()) {
      if (e.obj?.userData?.nodeTag === tag) return getEntity(e.obj);
    }
    return null;
  },
  findAllByTag(tag) {
    return registry()
      .filter((e) => e.obj?.userData?.nodeTag === tag)
      .map((e) => getEntity(e.obj))
      .filter(Boolean);
  },
  findComponent(token) {
    for (const e of registry()) {
      const ent = getEntity(e.obj);
      if (!ent) continue;
      const hit = findOnEntity(ent, token);
      if (hit) return hit;
    }
    return null;
  },
  findComponents(token) {
    const out = [];
    for (const e of registry()) {
      const ent = getEntity(e.obj);
      if (!ent) continue;
      const hit = findOnEntity(ent, token);
      if (hit) out.push(hit);
    }
    return out;
  },
};

export { animationApi, audioApi, particlesApi, physicsApi, sceneApi };