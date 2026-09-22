// node.set 参数解析与变换合并（纯函数，独立模块便于单测）。
// 支持两种调用形式：
// ① { id, prop, value } 单属性——devtools/MCP 历史契约；
// ② { id, ...fields } 字段包——助手/LLM 自然形态，name/visible/active/tag/
//    transform/position/rotation/scale 等任意混写。
// transform 与位移/旋转/缩放分量均按部分字段逐轴合并（未给的分量保持原值），
// 不整包覆盖；name 走重命名；其余属性整值补丁进一次撤销历史。

import type { JsonRecord, JsonValue } from "../../framework/prototype/types";
import type { TransformSnapshot } from "../../framework/scene/SceneClient";

/** 解析成功的分类补丁 */
export interface NodeSetPatch {
  /** 重命名目标（name 字段；未提供为 undefined） */
  name?: string;
  /** 变换部分补丁（position/rotation/scale 逐轴合并） */
  transform?: Record<string, unknown>;
  /** 其余属性补丁（整值覆盖，一次撤销） */
  props?: JsonRecord;
}

/** 节点 JSON 中不可经 node.set 修改的字段：身份/层级/原型绑定 */
const FORBIDDEN = new Set(["id", "childIds", "parentId", "children", "type"]);
/** 归入变换合并的属性名 */
const TRANSFORM_KEYS = new Set(["transform", "position", "rotation", "scale"]);
const VEC_KEYS = ["x", "y", "z"] as const;

/** 解析 node.set 参数为分类补丁；不合法返回 { error } 供模型自纠 */
export function parseNodeSetArgs(args: unknown): { error: string } | { patch: NodeSetPatch } {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { error: "缺少参数（需 id 与待设置属性）" };
  }
  const raw = args as Record<string, unknown>;
  // prop/value 单属性形式优先；否则取字段包形式（排除调用标识字段）
  const pairs: Array<[string, unknown]> =
    raw.prop !== undefined
      ? [[String(raw.prop), raw.value]]
      : Object.entries(raw).filter(([k]) => k !== "id" && k !== "prop" && k !== "value");
  if (!pairs.length) return { error: "不支持设置的属性: (空)" };
  const patch: NodeSetPatch = {};
  const props: JsonRecord = {};
  for (const [prop, value] of pairs) {
    if (!prop) return { error: "不支持设置的属性: (空)" };
    if (FORBIDDEN.has(prop)) {
      return { error: `不支持设置的属性: ${prop}（身份/层级/类型不可改；换子节点用 node.add + node.remove）` };
    }
    if (prop === "name") {
      const name = String(value ?? "").trim();
      if (!name) return { error: "name 不能为空" };
      patch.name = name;
    } else if (TRANSFORM_KEYS.has(prop)) {
      const t = (patch.transform ??= {});
      if (prop === "transform") {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return { error: "transform 应为 {position/rotation/scale} 对象" };
        }
        Object.assign(t, value as Record<string, unknown>);
      } else {
        // 顶层 position/rotation/scale 视为对应分量的部分补丁
        t[prop] = value;
      }
    } else {
      props[prop] = value as JsonValue;
    }
  }
  if (!Object.keys(patch.transform ?? {}).length) delete patch.transform;
  if (Object.keys(props).length) patch.props = props;
  return { patch };
}

/** 当前变换快照（度制欧拉，与文件格式同构） */
export function currentTransform(position: { x: number; y: number; z: number }, rotation: { x: number; y: number; z: number }, scale: { x: number; y: number; z: number }): TransformSnapshot {
  return {
    position: { ...position },
    rotation: { ...rotation },
    scale: { ...scale },
  };
}

/** 变换部分补丁逐轴合并：未给的分量保持 current 原值；非法值返回 { error } */
export function mergeTransformSnapshot(
  current: TransformSnapshot,
  patch: Record<string, unknown>,
): { error: string } | { snapshot: TransformSnapshot } {
  const unknownKeys = Object.keys(patch).filter(
    (k) => !(["position", "rotation", "scale"] as const).includes(k as "position"),
  );
  if (unknownKeys.length) {
    return { error: `transform 含未知分量: ${unknownKeys.join("/")}（应为 position/rotation/scale）` };
  }
  const snapshot = currentTransform(current.position, current.rotation, current.scale);
  for (const key of ["position", "rotation", "scale"] as const) {
    const v = patch[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "object" || Array.isArray(v)) {
      return { error: `transform.${key} 应为 {x,y,z} 对象` };
    }
    const p = v as Record<string, unknown>;
    for (const ax of VEC_KEYS) {
      if (p[ax] === undefined || p[ax] === null) continue;
      const n = Number(p[ax]);
      if (!Number.isFinite(n)) {
        return { error: `transform.${key}.${ax} 不是数值` };
      }
      snapshot[key][ax] = n;
    }
    const unknown = Object.keys(p).filter((k) => !VEC_KEYS.includes(k as "x" | "y" | "z"));
    if (unknown.length) {
      return { error: `transform.${key} 含未知分量: ${unknown.join("/")}（应为 x/y/z）` };
    }
  }
  return { snapshot };
}
