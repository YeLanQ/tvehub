// ---------------------------------------------------------------------------
// Entity：节点句柄（three 对象的引擎语义包装）
// 组件函数经 state 注入解耦（不直接导入 component-registry / runtime，打破循环依赖）。
// ---------------------------------------------------------------------------
import * as THREE from "../three.module.min.js";
import { postLog } from "../log";
import { state, registry, isNodeObj, numOr, D2R, R2D, scriptComponentsOf } from "./state";

function toVec3(v) {
  return { x: v.x, y: v.y, z: v.z };
}

/** 写入部分字段（仅接受有限数值，其余保持原值） */
function applyVec3(target, src) {
  if (!src || typeof src !== "object") return;
  for (const k of ["x", "y", "z"]) {
    const v = src[k];
    if (typeof v === "number" && Number.isFinite(v)) target[k] = v;
  }
}

/** 子树内按名称深度优先查找（只匹配节点对象，跳过灯光实例等内部子对象） */
export function deepFind(obj, name) {
  for (const child of obj.children) {
    if (isNodeObj(child) && child.name === name) return child;
    const hit = deepFind(child, name);
    if (hit) return hit;
  }
  return null;
}

/** three 对象 → Entity 子类实例（按 userData.nodeKind 映射节点类型类；非节点对象返回 null） */
export function getEntity(obj) {
  if (!isNodeObj(obj) || !state.host) return null;
  let e = state.entityByObj.get(obj);
  if (!e) {
    const kind = typeof obj.userData?.nodeKind === "string" ? obj.userData.nodeKind : "";
    const Cls = kind && KIND_CLASSES[kind] ? KIND_CLASSES[kind] : Entity;
    e = new Cls(obj);
    state.entityByObj.set(obj, e);
  }
  return e;
}

class Entity {
  /** @param {THREE.Object3D} obj（不在场景树内的对象由宿主保证不传入） */
  constructor(obj) {
    this.__obj = obj;
  }

  get id() {
    return String(this.__obj.userData.nodeId ?? "");
  }

  get kind() {
    const k = this.__obj.userData?.nodeKind;
    return typeof k === "string" ? k : "";
  }

  get name() {
    return this.__obj.name ?? "";
  }
  set name(value) {
    if (typeof value === "string" && value) this.__obj.name = value;
  }

  get tag() {
    const t = this.__obj.userData?.nodeTag;
    return typeof t === "string" ? t : "";
  }

  get layer() {
    const l = this.__obj.userData?.nodeLayer;
    return typeof l === "number" && Number.isFinite(l) ? Math.round(l) : 0;
  }
  set layer(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    const i = Math.min(31, Math.max(0, Math.round(n)));
    this.__obj.layers.set(i);
    this.__obj.traverse((o) => {
      if (o.isLight !== true) o.layers.set(i);
    });
    this.__obj.userData.nodeLayer = i;
  }

  get visible() {
    return this.__obj.visible === true;
  }
  set visible(value) {
    this.__obj.visible = value === true;
  }

  get position() {
    return toVec3(this.__obj.position);
  }
  set position(value) {
    applyVec3(this.__obj.position, value);
  }

  get rotation() {
    const r = this.__obj.rotation;
    return { x: r.x * R2D, y: r.y * R2D, z: r.z * R2D };
  }
  set rotation(value) {
    const r = this.__obj.rotation;
    if (!value || typeof value !== "object") return;
    r.order = "XYZ";
    if (typeof value.x === "number" && Number.isFinite(value.x)) r.x = value.x * D2R;
    if (typeof value.y === "number" && Number.isFinite(value.y)) r.y = value.y * D2R;
    if (typeof value.z === "number" && Number.isFinite(value.z)) r.z = value.z * D2R;
  }

  get scale() {
    return toVec3(this.__obj.scale);
  }
  set scale(value) {
    applyVec3(this.__obj.scale, value);
  }

  get worldPosition() {
    const v = new THREE.Vector3();
    this.__obj.getWorldPosition(v);
    return toVec3(v);
  }

  get parent() {
    const p = this.__obj.parent;
    return isNodeObj(p) ? getEntity(p) : null;
  }

  get children() {
    return this.__obj.children.filter(isNodeObj).map((c) => getEntity(c)).filter(Boolean);
  }

  translate(x, y, z) {
    this.__obj.position.x += numOr(x, 0);
    this.__obj.position.y += numOr(y, 0);
    this.__obj.position.z += numOr(z, 0);
  }

  rotate(xDeg, yDeg, zDeg) {
    const r = this.__obj.rotation;
    r.x += numOr(xDeg, 0) * D2R;
    r.y += numOr(yDeg, 0) * D2R;
    r.z += numOr(zDeg, 0) * D2R;
  }

  lookAt(target) {
    if (!target || typeof target !== "object") return;
    this.__obj.lookAt(numOr(target.x, 0), numOr(target.y, 0), numOr(target.z, 0));
    if (!this.__obj.isCamera) this.__obj.rotateY(Math.PI);
  }

  find(nameOrPath) {
    if (typeof nameOrPath !== "string" || !nameOrPath.trim()) return null;
    const parts = nameOrPath.split("/").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return null;
    let cur = this.__obj;
    for (let i = 0; i < parts.length; i++) {
      const next = cur.children.find((c) => isNodeObj(c) && c.name === parts[i]);
      if (!next) {
        if (i !== 0) return null;
        const hit = deepFind(cur, parts[0]);
        return hit ? getEntity(hit) : null;
      }
      cur = next;
    }
    return getEntity(cur);
  }

  getComponent(componentClass) {
    const typeKey = state.builtinTypeKeyOf?.(componentClass);
    if (typeKey) return state.builtinFacadeOf?.(this, typeKey);
    if (typeof componentClass === "function") {
      const list = scriptComponentsOf(this.id);
      if (!list) return null;
      return list.find((c) => c instanceof componentClass) ?? null;
    }
    if (typeof componentClass === "string") {
      return state.resolveScriptInstance?.(this.id, componentClass) ?? null;
    }
    return null;
  }

  addComponent(componentClass, settings) {
    const typeKey = state.builtinTypeKeyOf?.(componentClass);
    if (!typeKey) {
      if (typeof componentClass === "function" || typeof componentClass === "string") {
        return state.host?.scripts?.spawn?.(this, componentClass, settings) ?? null;
      }
      postLog("warn", "[tve] addComponent 仅支持内置组件或脚本组件类型");
      return null;
    }
    if (typeKey === "rigidBody" || typeKey === "collider") {
      postLog("warn", "[tve] 运行时不支持动态创建物理组件（请在编辑器中为节点挂载）");
      return null;
    }
    return state.createRuntimeBuiltin?.(this, typeKey, settings) ?? null;
  }
}

// KIND_CLASSES 由 node-types.mjs 注入（避免 entity → node-types 循环依赖）
let KIND_CLASSES = {};
export function setKindClasses(map) {
  KIND_CLASSES = map;
}

export { Entity };