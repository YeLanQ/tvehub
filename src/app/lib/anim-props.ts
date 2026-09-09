// ---------------------------------------------------------------------------
// 可动画属性目录（编辑器侧）：按节点能力动态提供可添加的动画通道。
//
// 通道键分组约定（与播放器 animclip.mjs 的应用规则镜像）：
// - "position.x" / "rotation.x" / "scale.x" → 节点对象变换（rotation 度制）；
// - "light.intensity"                        → 对象子树内首个灯光的属性；
// - "material.color.r" / "material.metalness" → 对象材质（颜色分量为 0~1）。
// 新增可动画组：在此登记 read（当前值读取），并同步播放器 applyValues 的
// 分组应用逻辑。
// ---------------------------------------------------------------------------

import type { Node } from "../../framework/prototype/Node";
import { LightNode, MeshNode } from "../../framework/prototype/derived/Primitives";
import type { MaterialParams } from "../../framework/material";

/** 编辑器引擎的最小读取面（避免整包依赖） */
export interface AnimPropEngine {
  materials: {
    paramsFor(rel: string): MaterialParams;
  };
}

export interface AnimPropDef {
  /** 通道键（clip.curves.prop） */
  prop: string;
  /** 展示名 */
  label: string;
  /** 层级路径（一级一级展示，如 Transform/Position/X） */
  path: string;
  /** 分组名（添加属性菜单的一级分类） */
  group: string;
  /** 读取节点当前值（K 帧/录制捕获用） */
  read: (node: Node, engine: AnimPropEngine) => number;
}


/** 材质参数当前值（按 .mat 缓存读取） */
function matParam(node: Node, engine: AnimPropEngine, path: string): number {
  const m = node as unknown as { material: string };
  const p = engine.materials.paramsFor(m.material);
  if (path.startsWith("color.")) {
    // MaterialParams.color 为 0xRRGGBB 整数；通道值归一化到 0~1
    const ch = path.slice("color.".length);
    const shift = ch === "r" ? 16 : ch === "g" ? 8 : 0;
    return ((p.color >> shift) & 255) / 255;
  }
  const key = path as keyof MaterialParams;
  const v = p[key];
  return typeof v === "number" ? v : 0;
}

function def(prop: string, label: string, path: string, group: string, read: (n: Node, e: AnimPropEngine) => number): AnimPropDef {
  return { prop, label, path, group, read };
}

// —— 各组通道定义 ——

const TRANSFORM_PROPS: AnimPropDef[] = [
  def("position.x", "位置 X", "Transform/Position/X", "变换", (n) => n.transform.position.x),
  def("position.y", "位置 Y", "Transform/Position/Y", "变换", (n) => n.transform.position.y),
  def("position.z", "位置 Z", "Transform/Position/Z", "变换", (n) => n.transform.position.z),
  def("rotation.x", "旋转 X", "Transform/Rotation/X", "变换", (n) => n.transform.rotation.x),
  def("rotation.y", "旋转 Y", "Transform/Rotation/Y", "变换", (n) => n.transform.rotation.y),
  def("rotation.z", "旋转 Z", "Transform/Rotation/Z", "变换", (n) => n.transform.rotation.z),
  def("scale.x", "缩放 X", "Transform/Scale/X", "变换", (n) => n.transform.scale.x),
  def("scale.y", "缩放 Y", "Transform/Scale/Y", "变换", (n) => n.transform.scale.y),
  def("scale.z", "缩放 Z", "Transform/Scale/Z", "变换", (n) => n.transform.scale.z),
];

const LIGHT_PROPS: AnimPropDef[] = [
  def("light.intensity", "灯光强度", "Light/Intensity", "灯光", (n) => (n as unknown as { intensity: number }).intensity),
];

const MATERIAL_PROPS: AnimPropDef[] = [
  def("material.color.r", "颜色 R", "Material/Color/R", "材质", (n, e) => matParam(n, e, "color.r")),
  def("material.color.g", "颜色 G", "Material/Color/G", "材质", (n, e) => matParam(n, e, "color.g")),
  def("material.color.b", "颜色 B", "Material/Color/B", "材质", (n, e) => matParam(n, e, "color.b")),
  def("material.metalness", "金属度", "Material/Metalness", "材质", (n, e) => matParam(n, e, "metalness")),
  def("material.roughness", "粗糙度", "Material/Roughness", "材质", (n, e) => matParam(n, e, "roughness")),
  def("material.emissiveIntensity", "自发光强度", "Material/Emissive Intensity", "材质", (n, e) => matParam(n, e, "emissiveIntensity")),
];

/** 按节点能力给出可添加的属性组（变换恒可用；灯光/材质按节点类型与数据） */
export function animPropGroupsFor(node: Node): { group: string; items: AnimPropDef[] }[] {
  const groups: { group: string; items: AnimPropDef[] }[] = [
    { group: "变换", items: TRANSFORM_PROPS },
  ];
  if (node instanceof LightNode) groups.push({ group: "灯光", items: LIGHT_PROPS });
  if (node instanceof MeshNode && node.source === "primitive" && node.material) {
    groups.push({ group: "材质", items: MATERIAL_PROPS });
  }
  return groups;
}

/** 全量静态目录（按通道键查定义；未知键返回 null） */
const ALL_DEFS: AnimPropDef[] = [...TRANSFORM_PROPS, ...LIGHT_PROPS, ...MATERIAL_PROPS];

export function propDefOf(prop: string): AnimPropDef | null {
  return ALL_DEFS.find((d) => d.prop === prop) ?? null;
}

/** 目录全路径自然序（动画编辑器轨道树子级排序；未知键排同名末尾） */
export const ANIM_PATHS: readonly string[] = ALL_DEFS.map((d) => d.path);
