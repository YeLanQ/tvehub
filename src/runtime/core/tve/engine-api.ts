// ---------------------------------------------------------------------------
// engine API：animation / audio / particles / physics / scene 控制接口
// 脚本经 engine.animation / engine.audio / engine.particles / engine.physics /
// engine.scene 调用；按实体寻址，转发到宿主后端。
// ---------------------------------------------------------------------------
import { state, numOr, registry } from "./state";
import type { BuiltinFacade } from "./state";
import { getEntity, deepFind } from "./entity";
import type { Entity } from "./entity";
import { resolveScriptInstance, resolveNodeEntity } from "./runtime";
import { builtinTypeKeyOf, builtinFacadeOf } from "./component-registry";

const animationApi = {
  play(entity: Entity, clip: string | undefined): void { state.host?.animations?.play(entity?.id, clip); },
  stop(entity: Entity): void { state.host?.animations?.stop(entity?.id); },
  pause(entity: Entity): void { state.host?.animations?.pause(entity?.id); },
  resume(entity: Entity): void { state.host?.animations?.resume(entity?.id); },
};

const audioApi = {
  play(entity: Entity): void { state.host?.audios?.play(entity?.id); },
  stop(entity: Entity): void { state.host?.audios?.stop(entity?.id); },
  pause(entity: Entity): void { state.host?.audios?.pause(entity?.id); },
  resume(entity: Entity): void { state.host?.audios?.resume(entity?.id); },
  setVolume(entity: Entity, volume: number): void { state.host?.audios?.setVolume(entity?.id, volume); },
};

const particlesApi = {
  play(entity: Entity): void { state.host?.particles?.play(entity?.id); },
  pause(entity: Entity): void { state.host?.particles?.pause(entity?.id); },
  stop(entity: Entity): void { state.host?.particles?.stop(entity?.id); },
  restart(entity: Entity): void { state.host?.particles?.restart(entity?.id); },
  clear(entity: Entity): void { state.host?.particles?.clear(entity?.id); },
  stateOf(entity: Entity) { return state.host?.particles?.infoOf(entity?.id) ?? null; },
  setSettings(entity: Entity, patch: unknown): void { state.host?.particles?.updateSettings(entity?.id, patch); },
};

const physicsApi = {
  applyImpulse(entity: Entity, x: unknown, y: unknown, z: unknown): void {
    state.host?.physics?.applyImpulse(entity?.id, numOr(x, 0), numOr(y, 0), numOr(z, 0));
  },
  applyForce(entity: Entity, x: unknown, y: unknown, z: unknown): void {
    state.host?.physics?.applyForce(entity?.id, numOr(x, 0), numOr(y, 0), numOr(z, 0));
  },
  setLinearVelocity(entity: Entity, x: unknown, y: unknown, z: unknown): void {
    state.host?.physics?.setLinearVelocity(entity?.id, numOr(x, 0), numOr(y, 0), numOr(z, 0));
  },
  setAngularVelocity(entity: Entity, x: unknown, y: unknown, z: unknown): void {
    state.host?.physics?.setAngularVelocity(entity?.id, numOr(x, 0), numOr(y, 0), numOr(z, 0));
  },
  getLinearVelocity(entity: Entity) {
    return state.host?.physics?.getLinearVelocity(entity?.id) ?? null;
  },
  bodyInfo(entity: Entity) {
    return state.host?.physics?.bodyInfo(entity?.id) ?? null;
  },
  setGravityScale(entity: Entity, scale: unknown): void {
    state.host?.physics?.setGravityScale(entity?.id, numOr(scale, 1));
  },
  wakeUp(entity: Entity): void {
    state.host?.physics?.wakeUp(entity?.id);
  },
  setGravity(x: unknown, y: unknown, z: unknown): void {
    state.host?.physics?.setGravity(numOr(x, 0), numOr(y, -9.81), numOr(z, 0));
  },
  /** 射线投射（世界级查询，不按实体寻址；Worker 模式返回 Promise） */
  castRay(options: unknown) {
    return state.host?.physics?.castRay(options) ?? [];
  },
};

/** 单实体按 token 找组件：脚本类 / 脚本路径 / 类名 / 内置组件门面类 / 类型键 */
function findOnEntity(entity: Entity, token: unknown): BuiltinFacade | object | null {
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
  find(nameOrPath: string) {
    const rootObj = state.host && state.host.rootObj;
    if (!rootObj) return null;
    if (rootObj.name === nameOrPath) return getEntity(rootObj);
    const hit = deepFind(rootObj, nameOrPath);
    if (hit) return getEntity(hit);
    // 名字/路径未命中按节点 id 回退（castRay 命中结果只携带 nodeId）
    return resolveNodeEntity(nameOrPath);
  },
  findAll() {
    return registry()
      .map((e) => getEntity(e.obj))
      .filter((e): e is Entity => Boolean(e));
  },
  findByTag(tag: string) {
    for (const e of registry()) {
      if (e.obj?.userData?.nodeTag === tag) return getEntity(e.obj);
    }
    return null;
  },
  findAllByTag(tag: string) {
    return registry()
      .filter((e) => e.obj?.userData?.nodeTag === tag)
      .map((e) => getEntity(e.obj))
      .filter((e): e is Entity => Boolean(e));
  },
  findComponent(token: unknown) {
    for (const e of registry()) {
      const ent = getEntity(e.obj);
      if (!ent) continue;
      const hit = findOnEntity(ent, token);
      if (hit) return hit;
    }
    return null;
  },
  findComponents(token: unknown) {
    const out: Array<BuiltinFacade | object | null> = [];
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
