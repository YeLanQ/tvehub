// ---------------------------------------------------------------------------
// 通用实体属性路径（「属性读取」卡与「设置属性」卡共用的寻址内核）。
//
// 点分路径解析到实体的 THREE 对象树上，读（拉模型数据引脚）与写（op.set）
// 同一套语义、读写对称：
// - 变换分量：position.x|y|z / rotation.x|y|z（度制，写侧转弧度）/ scale.x|y|z
//   / worldPosition.x|y|z（只读）；整段向量（如 position）读回 vec3；
// - 状态与身份：visible(bool) / name / tag / kind / id（userData 标记）；
// - 灯光分量：light.intensity|distance|penumbra / light.angle(度) /
//   light.color(0xRRGGBB)——对象树内找首个光源；
// - 材质标量：material.<数值/布尔/字符串属性>（如 opacity）与 material.color；
// - userData.<键>（原始值快照）；
// - 脚本组件属性：script:<脚本路径>:<属性>（@property 字段实时值；
//   需要 player 注入 scriptApi，未注入时读 null / 写 false）。
// 路径只解析「目标实体自身」的属性：子级实体不经路径寻址（历史版本的
// <子级名>.<路径> 已移除），要读写子级属性请连「获取子级」(op.children) +
// 「子级索引」(op.childIndex) 卡把作用对象换成具体子级后再接本套路径。
// 读失败回 null（引脚空值语义），写失败回 false（op.set 侧 warnOnce 可定位）。
// 不抛错：所有解析容错，畸形路径只是"取不到"。
// ---------------------------------------------------------------------------

import type * as THREE from "three";
import type { NodeObj, DataValue, GraphScriptApi } from "./graph-runtime";

const R2D = 180 / Math.PI;

/** Object3D 鸭子判定（不依赖 THREE 值导入：稳定产物里 three 是外部模块） */
function isObj3(v: unknown): v is THREE.Object3D {
  return !!v && typeof v === "object" && (v as { isObject3D?: boolean }).isObject3D === true;
}
/** 向量/欧拉式三分量持有者（有数值 x/y/z） */
function isVec3ish(v: unknown): v is { x: number; y: number; z: number } {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.x === "number" && typeof o.y === "number" && typeof o.z === "number";
}
function isColor(v: unknown): v is THREE.Color {
  return !!v && typeof v === "object" && (v as { isColor?: boolean }).isColor === true;
}
function isLight(v: unknown): v is THREE.Light {
  return !!v && typeof v === "object" && (v as { isLight?: boolean }).isLight === true;
}

/** 对象树内找首个光源（与 core-ops setLightPath 同规则） */
function findLight(obj: THREE.Object3D): THREE.Light | null {
  let hit: THREE.Light | null = null;
  obj.traverse((o) => {
    if (!hit && isLight(o)) hit = o as THREE.Light;
  });
  return hit;
}

/** 对象树内找首个网格材质（数组材质取首个） */
function findMaterial(obj: THREE.Object3D): THREE.Material | null {
  let hit: THREE.Material | null = null;
  obj.traverse((o) => {
    if (hit) return;
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!m) return;
    hit = Array.isArray(m) ? m[0] ?? null : m;
  });
  return hit;
}

/** 欧拉判定（有 order 字符串 → 角度分量按度制换算） */
function isEulerish(v: { x: number; y: number; z: number } & Record<string, unknown>): boolean {
  return typeof v.order === "string";
}

/** 标量收敛（只暴露可进数据引脚的值；对象/函数/Entity 一律 null） */
function scalar(v: unknown): number | boolean | string | null {
  const t = typeof v;
  if (t === "number" && Number.isFinite(v as number)) return v as number;
  if (t === "boolean") return v as boolean;
  if (t === "string") return v as string;
  return null;
}

/** 读取 script:<路径>:<属性> 的拆段（rel 允许含 "/"，不允许含 ":"） */
function parseScriptPath(path: string): { rel: string; key: string } | null {
  if (!path.startsWith("script:")) return null;
  const rest = path.slice(7);
  const idx = rest.lastIndexOf(":");
  if (idx < 0 || idx >= rest.length - 1) return null;
  return { rel: rest.slice(0, idx), key: rest.slice(idx + 1) };
}

/**
 * 路径段单步求值（中间段与最终段共用）：
 * 当前持有者 cur 按段类型解析出下一持有者/叶子值；无法解析回 undefined。
 */
function step(cur: unknown, seg: string, owner: NodeObj): unknown {
  // 灯光：距离/强度直读；锥角/半影度制换算（Light 是 Object3D 子类，必须先于对象分支判定）
  if (isLight(cur)) {
    if (seg === "intensity") return (cur as THREE.Light).intensity;
    if (seg === "distance") return (cur as THREE.PointLight).distance ?? 0;
    if (seg === "angle") return ((cur as THREE.SpotLight).angle ?? 0) * R2D;
    if (seg === "penumbra") return (cur as THREE.SpotLight).penumbra ?? 0;
    if (seg === "color") return (cur as THREE.Light).color;
    return undefined;
  }
  // Object3D：内置分量 → 特殊持有者；未知段不下降子级（子级经获取子级/子级索引卡换目标）
  if (isObj3(cur)) {
    const o = cur;
    switch (seg) {
      case "position": return o.position;
      case "rotation": return o.rotation;
      case "scale": return o.scale;
      case "worldPosition": {
        // 借现有 Vector3 实例作 scratch（避免引入 THREE 值依赖），只读语义
        const tmp = (o.position as THREE.Vector3).clone();
        o.getWorldPosition(tmp);
        return tmp;
      }
      case "visible": return o.visible;
      case "active": return o.visible; // 运行时对象无独立 active 位，语义并入 visible
      case "name": return o.name;
      case "tag": return String(o.userData?.nodeTag ?? "");
      case "kind": case "type": return String(o.userData?.nodeKind ?? "");
      case "id": return String(o.userData?.nodeId ?? owner.id);
      case "light": return findLight(o);
      case "material": return findMaterial(o);
      case "userData": return o.userData;
      default: return undefined;
    }
  }
  // 向量 / 欧拉（世界位置读回的是 Vector3 实例，同路处理）
  if (isVec3ish(cur)) {
    const v = cur as { x: number; y: number; z: number } & Record<string, unknown>;
    if (seg === "x") return isEulerish(v) ? v.x * R2D : v.x;
    if (seg === "y") return isEulerish(v) ? v.y * R2D : v.y;
    if (seg === "z") return isEulerish(v) ? v.z * R2D : v.z;
    return undefined;
  }
  // 颜色：分量 0..1 或 hex 数值
  if (isColor(cur)) {
    if (seg === "r") return cur.r;
    if (seg === "g") return cur.g;
    if (seg === "b") return cur.b;
    if (seg === "hex") return cur.getHex();
    return undefined;
  }
  // 材质 / userData 等普通持有者：仅暴露标量属性
  const holder = cur as Record<string, unknown>;
  if (seg === "color" && isColor(holder.color)) return holder.color;
  const v = holder[seg];
  const t = typeof v;
  if (t === "number" || t === "boolean" || t === "string") return v;
  return undefined;
}

/** 叶子收敛：三分量持有者 → vec3；颜色 → hex；其余标量（对象/子级一律 null） */
function finalize(v: unknown): DataValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
  if (isColor(v)) return v.getHex();
  if (isVec3ish(v)) {
    const o = v as { x: number; y: number; z: number } & Record<string, unknown>;
    if (isEulerish(o)) return { x: o.x * R2D, y: o.y * R2D, z: o.z * R2D };
    return { x: o.x, y: o.y, z: o.z };
  }
  return null;
}

/** 通用读（path 为点分路径或 script:<路径>:<属性>） */
export function readPropPath(
  owner: NodeObj,
  path: string,
  scriptApi?: GraphScriptApi | null,
): DataValue {
  const p = path.trim();
  if (!p) return null;
  const sp = parseScriptPath(p);
  if (sp) return scriptApi?.getProp(owner.id, sp.rel, sp.key) ?? null;
  const segs = p.split(".");
  let cur: unknown = owner.obj;
  for (const seg of segs) {
    if (cur === undefined || cur === null) return null;
    cur = step(cur, seg.trim(), owner);
  }
  return finalize(cur);
}

/** 通用写：先下降到倒数第二段持有者，再对最终段赋值；成功回 true */
export function writePropPath(
  owner: NodeObj,
  path: string,
  value: number | boolean | string,
  scriptApi?: GraphScriptApi | null,
): boolean {
  const p = path.trim();
  if (!p) return false;
  const sp = parseScriptPath(p);
  if (sp) return scriptApi?.setProp(owner.id, sp.rel, sp.key, value) ?? false;
  const segs = p.split(".").map((s) => s.trim());
  if (!segs.length || segs.some((s) => !s)) return false;
  const leaf = segs[segs.length - 1];
  let cur: unknown = owner.obj;
  for (let i = 0; i < segs.length - 1; i++) {
    cur = step(cur, segs[i], owner);
    if (cur === undefined || cur === null) return false;
  }
  // 灯光分量（angle 度制）——Light 是 Object3D 子类，必须先于对象分支判定
  if (isLight(cur)) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return false;
    if (leaf === "intensity") { (cur as THREE.Light).intensity = n; return true; }
    if (leaf === "distance") { (cur as THREE.PointLight).distance = n; return true; }
    if (leaf === "angle") { (cur as THREE.SpotLight).angle = n / R2D; return true; }
    if (leaf === "penumbra") { (cur as THREE.SpotLight).penumbra = n; return true; }
    return false;
  }
  // Object3D 叶子（visible/name/userData 容器/子级整体不可写标量）
  if (isObj3(cur)) {
    if (leaf === "visible" || leaf === "active") {
      cur.visible = typeof value === "boolean" ? value : value !== 0;
      return true;
    }
    if (leaf === "name") {
      cur.name = String(value);
      return true;
    }
    return false;
  }
  // 向量 / 欧拉分量（欧拉度制 → 弧度）
  if (isVec3ish(cur)) {
    const v = cur as { x: number; y: number; z: number } & Record<string, unknown>;
    if (leaf !== "x" && leaf !== "y" && leaf !== "z") return false;
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return false;
    v[leaf] = isEulerish(v) ? n / R2D : n;
    return true;
  }
  // 颜色
  if (isColor(cur)) {
    if (leaf === "hex" && typeof value === "number") {
      cur.setHex(value);
      return true;
    }
    if (leaf === "r" || leaf === "g" || leaf === "b") {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) return false;
      cur[leaf] = n;
      return true;
    }
    return false;
  }
  // 材质 / userData 等：仅写"已存在的同名标量属性"（避免凭空造字段）
  const holder = cur as Record<string, unknown>;
  const old = holder[leaf];
  const t = typeof old;
  if (t === "number") {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return false;
    holder[leaf] = n;
    return true;
  }
  if (t === "boolean") {
    holder[leaf] = typeof value === "boolean" ? value : value !== 0;
    return true;
  }
  if (t === "string") {
    holder[leaf] = String(value);
    return true;
  }
  return false;
}
