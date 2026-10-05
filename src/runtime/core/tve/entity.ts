// ---------------------------------------------------------------------------
// Entity：节点句柄（three 对象的引擎语义包装）
// 组件函数经 state 注入解耦（不直接导入 component-registry / runtime，打破循环依赖）。
// ---------------------------------------------------------------------------
import * as THREE from "../three.module.min.js";
import { postLog } from "../log";
import { state, isNodeObj, numOr, D2R, R2D, scriptComponentsOf } from "./state";
import type { Vec3, Vec3Input } from "./state";

/** 节点类型类构造器（getEntity 按 userData.nodeKind 构建实例；node-types.ts 注入） */
export type EntityKlass = new (obj: THREE.Object3D) => Entity;

function toVec3(v: THREE.Vector3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

/** 写入部分字段（仅接受有限数值，其余保持原值） */
function applyVec3(target: THREE.Vector3, src: Vec3Input | null | undefined): void {
  if (!src || typeof src !== "object") return;
  for (const k of ["x", "y", "z"] as const) {
    const v = src[k];
    if (typeof v === "number" && Number.isFinite(v)) target[k] = v;
  }
}

/** 子树内按名称深度优先查找（只匹配节点对象，跳过灯光实例等内部子对象） */
export function deepFind(obj: THREE.Object3D, name: string): THREE.Object3D | null {
  for (const child of obj.children) {
    if (isNodeObj(child) && child.name === name) return child;
    const hit = deepFind(child, name);
    if (hit) return hit;
  }
  return null;
}

/** three 对象 → Entity 子类实例（按 userData.nodeKind 映射节点类型类；非节点对象返回 null） */
export function getEntity(obj: THREE.Object3D): Entity | null {
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
  /** 节点类型类静态标记（node-types.ts 按 kind 写入；TS 需静态声明供子类赋值） */
  static declare __nodeKinds: string[] | null;

  /** three 节点对象（不在场景树内的对象由宿主保证不传入） */
  __obj: THREE.Object3D;

  constructor(obj: THREE.Object3D) {
    this.__obj = obj;
  }

  get id(): string {
    return String(this.__obj.userData.nodeId ?? "");
  }

  get kind(): string {
    const k = this.__obj.userData?.nodeKind;
    return typeof k === "string" ? k : "";
  }

  get name(): string {
    return this.__obj.name ?? "";
  }
  set name(value: string) {
    if (typeof value === "string" && value) this.__obj.name = value;
  }

  get tag(): string {
    const t = this.__obj.userData?.nodeTag;
    return typeof t === "string" ? t : "";
  }

  get layer(): number {
    const l = this.__obj.userData?.nodeLayer;
    return typeof l === "number" && Number.isFinite(l) ? Math.round(l) : 0;
  }
  set layer(value: number) {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    const i = Math.min(31, Math.max(0, Math.round(n)));
    this.__obj.layers.set(i);
    this.__obj.traverse((o) => {
      // three 类型库仅在实际灯型上声明 isLight；对象标志按结构视图读取
      if ((o as { isLight?: boolean }).isLight !== true) o.layers.set(i);
    });
    this.__obj.userData.nodeLayer = i;
  }

  get visible(): boolean {
    return this.__obj.visible === true;
  }
  set visible(value: boolean) {
    this.__obj.visible = value === true;
  }

  get position(): Vec3 {
    return toVec3(this.__obj.position);
  }
  set position(value: Vec3Input | null | undefined) {
    applyVec3(this.__obj.position, value);
  }

  get rotation(): Vec3 {
    const r = this.__obj.rotation;
    return { x: r.x * R2D, y: r.y * R2D, z: r.z * R2D };
  }
  set rotation(value: Vec3Input | null | undefined) {
    const r = this.__obj.rotation;
    if (!value || typeof value !== "object") return;
    r.order = "XYZ";
    if (typeof value.x === "number" && Number.isFinite(value.x)) r.x = value.x * D2R;
    if (typeof value.y === "number" && Number.isFinite(value.y)) r.y = value.y * D2R;
    if (typeof value.z === "number" && Number.isFinite(value.z)) r.z = value.z * D2R;
  }

  get scale(): Vec3 {
    return toVec3(this.__obj.scale);
  }
  set scale(value: Vec3Input | null | undefined) {
    applyVec3(this.__obj.scale, value);
  }

  get worldPosition(): Vec3 {
    const v = new THREE.Vector3();
    this.__obj.getWorldPosition(v);
    return toVec3(v);
  }

  get parent(): Entity | null {
    const p = this.__obj.parent;
    return isNodeObj(p) ? getEntity(p) : null;
  }

  get children(): Entity[] {
    return this.__obj.children
      .filter(isNodeObj)
      .map((c) => getEntity(c))
      .filter((e): e is Entity => Boolean(e));
  }

  translate(x: unknown, y: unknown, z: unknown): void {
    this.__obj.position.x += numOr(x, 0);
    this.__obj.position.y += numOr(y, 0);
    this.__obj.position.z += numOr(z, 0);
  }

  rotate(xDeg: unknown, yDeg: unknown, zDeg: unknown): void {
    const r = this.__obj.rotation;
    r.x += numOr(xDeg, 0) * D2R;
    r.y += numOr(yDeg, 0) * D2R;
    r.z += numOr(zDeg, 0) * D2R;
  }

  lookAt(target: Vec3Input | null | undefined): void {
    if (!target || typeof target !== "object") return;
    this.__obj.lookAt(numOr(target.x, 0), numOr(target.y, 0), numOr(target.z, 0));
    // three 类型库仅 Camera 类声明 isCamera；按结构视图读取
    if (!(this.__obj as { isCamera?: boolean }).isCamera) this.__obj.rotateY(Math.PI);
  }

  find(nameOrPath: string): Entity | null {
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

  getComponent(componentClass: unknown): unknown {
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

  addComponent(componentClass: unknown, settings: unknown): unknown {
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
let KIND_CLASSES: Record<string, EntityKlass> = {};
export function setKindClasses(map: Record<string, EntityKlass>): void {
  KIND_CLASSES = map;
}

export { Entity };
