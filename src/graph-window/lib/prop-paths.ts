// ---------------------------------------------------------------------------
// 属性路径候选（检查器 ComboBox 下拉用）：与运行时 graph-prop-path.ts 的解析
// 语义对齐的可寻址属性清单。基础分量（变换/状态/身份）为常量；灯光分量、材质
// 分量与脚本组件 @property（script:<路径>:<属性>）按场景实体快照动态生成。
// 路径只寻址实体自身的属性：子级不经路径，用「获取子级」/ForEach 换作用对象。
// ---------------------------------------------------------------------------

import { G_PROPERTY_PATHS } from "../../framework/graph";
import type { SceneEntity } from "./scene-index";

/** 实体自身的基础分量（变换 + 状态 + 身份；世界位置只读补充） */
export const ENTITY_BASE_PATHS: string[] = [
  ...G_PROPERTY_PATHS,
  "worldPosition.x",
  "worldPosition.y",
  "worldPosition.z",
  "name",
  "tag",
  "kind",
  "id",
];

/** 灯光分量（light 组件/灯光节点；角度类为度制） */
const LIGHT_PATHS = ["light.intensity", "light.distance", "light.angle", "light.penumbra", "light.color"];

/** 常用材质分量（对象树首个网格的材质；数值属性均可寻址，如 roughness） */
const MATERIAL_PATHS = ["material.opacity", "material.color"];

/** 单实体的可寻址属性路径（实体自身：基础分量 + 灯光/材质分量 + 脚本 @property；子级不经路径） */
export function entityPropPaths(entity: SceneEntity): string[] {
  const out = [...ENTITY_BASE_PATHS, ...MATERIAL_PATHS];
  if (entity.light) out.push(...LIGHT_PATHS);
  for (const s of entity.scripts) {
    for (const key of Object.keys(s.props)) out.push(`script:${s.script}:${key}`);
  }
  return out;
}

/** 多实体候选并集（保序去重） */
export function mergePropPaths(lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lists) for (const p of l) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}
