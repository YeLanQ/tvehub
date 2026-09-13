// ---------------------------------------------------------------------------
// 可动画属性目录（编辑器侧）：按选中节点的检查器属性卡片动态提供可添加的
// 动画通道（添加属性菜单跟随节点类型变化）。
//
// 通道键分组约定（与播放器 animclip.mjs 的应用规则镜像）：
// - "position.x" / "rotation.x" / "scale.x"  → 节点对象变换（rotation 度制）；
// - "light.intensity" / "light.color.r" /
//   "light.distance" / "light.angle" …       → 对象子树内首个灯光
//   （颜色分量 0~1；angle 通道为度制，应用侧转弧度）；
// - "camera.fov" / "camera.near" / "camera.far" → 渲染相机投影参数
//   （仅渲染相机节点的绑定生效；编辑器视口不经场景相机渲染，预览无视觉反馈）；
// - "ui.anchoredPosition.x" / "ui.size.x" / "ui.fontSize" … → UI 节点数据字段
//   （真属性：经 UI 系统生效——布局重解析、几何/文本按签名重建；位置/尺寸为
//   UI 单位，100px = 1 单位。UI 节点无 3D Transform 卡：变换组只出与 2D 卡
//   同源的 旋转Z / 缩放XY，画布节点不出变换组）；
// - "material.color.r" / "material.metalness" → 对象材质（颜色分量为 0~1）。
// 新增可动画组：在此登记 read（当前值读取），并同步播放器 animclip.mjs 的
// compileBinding/applyItem 分组应用逻辑与编辑器 useAnimPreview.applyChannels。
// ---------------------------------------------------------------------------

import type { Node } from "../../framework/prototype/Node";
import { isLightComponent } from "../../framework/prototype/Node";
import {
  CameraNode,
  LightNode,
  MeshNode,
  PointLightNode,
  SpotLightNode,
  UICanvasNode,
  UIButtonNode,
  UILayoutNode,
  UITextNode,
  UIWidgetNode,
} from "../../framework/prototype/derived/Primitives";
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
  /** 层级路径（一级一级展示，如 Transform/Position/X；添加属性菜单按段建子菜单） */
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

function def(prop: string, path: string, group: string, read: (n: Node, e: AnimPropEngine) => number): AnimPropDef {
  return { prop, path, group, read };
}

// —— 变换组（所有节点恒可用） ——

const TRANSFORM_PROPS: AnimPropDef[] = [
  def("position.x", "Transform/Position/X", "变换", (n) => n.transform.position.x),
  def("position.y", "Transform/Position/Y", "变换", (n) => n.transform.position.y),
  def("position.z", "Transform/Position/Z", "变换", (n) => n.transform.position.z),
  def("rotation.x", "Transform/Rotation/X", "变换", (n) => n.transform.rotation.x),
  def("rotation.y", "Transform/Rotation/Y", "变换", (n) => n.transform.rotation.y),
  def("rotation.z", "Transform/Rotation/Z", "变换", (n) => n.transform.rotation.z),
  def("scale.x", "Transform/Scale/X", "变换", (n) => n.transform.scale.x),
  def("scale.y", "Transform/Scale/Y", "变换", (n) => n.transform.scale.y),
  def("scale.z", "Transform/Scale/Z", "变换", (n) => n.transform.scale.z),
];

/** UI Widget 的变换子集（2D 变换卡同源：旋转 = rotation.z、缩放 = scale.x/y） */
const UI_2D_TRANSFORM_PROPS: AnimPropDef[] = TRANSFORM_PROPS.filter((d) =>
  d.prop === "rotation.z" || d.prop === "scale.x" || d.prop === "scale.y",
);

// —— 灯光组（灯光节点或启用的灯光组件；字段与检查器 Light 卡一致） ——

/**
 * 灯光参数读取源（灯光节点或节点上启用的灯光组件，字段同构：
 * intensity/lightColor + 点光/聚光的 distance/decay + 聚光的 angle/penumbra）。
 * 返回 null = 当前节点无灯光能力（不出灯光组）。
 */
interface LightCap {
  src: Record<string, unknown>;
  /** 点光/聚光（有 distance/decay） */
  pointOrSpot: boolean;
  /** 聚光（另有 angle/penumbra） */
  spot: boolean;
}

function lightCapOf(node: Node): LightCap | null {
  if (node instanceof LightNode) {
    return {
      src: node as unknown as Record<string, unknown>,
      pointOrSpot: node instanceof PointLightNode || node instanceof SpotLightNode,
      spot: node instanceof SpotLightNode,
    };
  }
  // 组件模式：灯光组件挂任意节点（检查器 Light 组件卡），与灯光节点同一通道集
  const comp = node.components.find(isLightComponent);
  if (!comp || !comp.enabled) return null;
  const kind = comp.light.kind;
  return {
    src: comp.light as unknown as Record<string, unknown>,
    pointOrSpot: kind === "point" || kind === "spot",
    spot: kind === "spot",
  };
}

/** 0xRRGGBB 颜色分量 → 0~1 通道值（与材质颜色通道同约定） */
function hexComponent(hex: unknown, shift: number): number {
  return typeof hex === "number" ? ((hex >> shift) & 255) / 255 : 0;
}

function numField(src: Record<string, unknown>, key: string): number {
  const v = src[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** 灯光通道适用档位：any = 全部灯光；pointOrSpot/spot 按灯型显隐 */
type LightRequire = "any" | "pointOrSpot" | "spot";

function lightDef(
  require: LightRequire,
  prop: string,
  path: string,
  read: (cap: LightCap) => number,
): AnimPropDef & { require: LightRequire } {
  return {
    prop,
    path,
    group: "灯光",
    require,
    read: (n) => {
      const c = lightCapOf(n);
      return c ? read(c) : 0;
    },
  };
}

const LIGHT_PROPS: (AnimPropDef & { require: LightRequire })[] = [
  lightDef("any", "light.intensity", "Light/Intensity", (c) => numField(c.src, "intensity")),
  lightDef("any", "light.color.r", "Light/Color/R", (c) => hexComponent(c.src.lightColor, 16)),
  lightDef("any", "light.color.g", "Light/Color/G", (c) => hexComponent(c.src.lightColor, 8)),
  lightDef("any", "light.color.b", "Light/Color/B", (c) => hexComponent(c.src.lightColor, 0)),
  lightDef("pointOrSpot", "light.distance", "Light/Range", (c) => numField(c.src, "distance")),
  lightDef("pointOrSpot", "light.decay", "Light/Decay", (c) => numField(c.src, "decay")),
  // angle 通道值为度（与节点/检查器单位一致），应用侧转弧度
  lightDef("spot", "light.angle", "Light/Angle", (c) => numField(c.src, "angle")),
  lightDef("spot", "light.penumbra", "Light/Penumbra", (c) => numField(c.src, "penumbra")),
];

function lightDefsFor(cap: LightCap): AnimPropDef[] {
  return LIGHT_PROPS.filter(
    (d) =>
      d.require === "any" ||
      (d.require === "pointOrSpot" && cap.pointOrSpot) ||
      (d.require === "spot" && cap.spot),
  );
}

// —— 相机组（相机卡数值：fov 仅透视；near/far 通用） ——

type CameraRequire = "any" | "perspective";

function cameraDef(
  require: CameraRequire,
  prop: string,
  path: string,
  key: "fov" | "near" | "far",
): AnimPropDef & { require: CameraRequire } {
  return {
    prop,
    path,
    group: "相机",
    require,
    read: (n) => (n as CameraNode)[key],
  };
}

const CAMERA_PROPS: (AnimPropDef & { require: CameraRequire })[] = [
  cameraDef("perspective", "camera.fov", "Camera/Fov", "fov"),
  cameraDef("any", "camera.near", "Camera/Near", "near"),
  cameraDef("any", "camera.far", "Camera/Far", "far"),
];

function cameraDefsFor(node: CameraNode): AnimPropDef[] {
  return CAMERA_PROPS.filter(
    (d) => d.require === "any" || (d.require === "perspective" && node.cameraType === "perspective"),
  );
}

// —— 材质组（基元网格 .mat 参数，与检查器 Material 卡数值对应） ——

const MATERIAL_PROPS: AnimPropDef[] = [
  def("material.color.r", "Material/Color/R", "材质", (n, e) => matParam(n, e, "color.r")),
  def("material.color.g", "Material/Color/G", "材质", (n, e) => matParam(n, e, "color.g")),
  def("material.color.b", "Material/Color/B", "材质", (n, e) => matParam(n, e, "color.b")),
  def("material.metalness", "Material/Metalness", "材质", (n, e) => matParam(n, e, "metalness")),
  def("material.roughness", "Material/Roughness", "材质", (n, e) => matParam(n, e, "roughness")),
  def("material.emissiveIntensity", "Material/Emissive Intensity", "材质", (n, e) => matParam(n, e, "emissiveIntensity")),
];

// —— UI 组（2D 变换卡 + 控件卡数值；通道值为节点数据原单位——位置/尺寸是
//    UI 单位（100px = 1 单位）、字号为设计像素。旋转/缩放卡字段即节点
//    transform，已由「变换」组的 rotation.z / scale.x/y 覆盖）——
// 位置/尺寸按轴出通道：只在点锚点轴生效（拉伸轴矩形由父矩形与边距推导，
// 改了无视觉效果）；布局容器（mode≠none）的直接子节点位置由布局接管。 ——

const UI_POS_X = def("ui.anchoredPosition.x", "UI/Position/X", "UI", (n) => (n as UIWidgetNode).anchoredPosition.x);
const UI_POS_Y = def("ui.anchoredPosition.y", "UI/Position/Y", "UI", (n) => (n as UIWidgetNode).anchoredPosition.y);
const UI_SIZE_W = def("ui.size.x", "UI/Size/W", "UI", (n) => (n as UIWidgetNode).size.x);
const UI_SIZE_H = def("ui.size.y", "UI/Size/H", "UI", (n) => (n as UIWidgetNode).size.y);
const UI_SORT_ORDER = def("ui.sortOrder", "UI/Sort Order", "UI", (n) => (n as UIWidgetNode).sortOrder);

const UI_TEXT_PROPS: AnimPropDef[] = [
  def("ui.fontSize", "UI/Font Size", "UI", (n) => (n as UITextNode).fontSize),
];

const UI_LAYOUT_PROPS: AnimPropDef[] = [
  def("ui.spacing.x", "UI/Spacing/X", "UI", (n) => (n as UILayoutNode).spacing.x),
  def("ui.spacing.y", "UI/Spacing/Y", "UI", (n) => (n as UILayoutNode).spacing.y),
  def("ui.padding.left", "UI/Padding/Left", "UI", (n) => (n as UILayoutNode).padding.left),
  def("ui.padding.right", "UI/Padding/Right", "UI", (n) => (n as UILayoutNode).padding.right),
  def("ui.padding.top", "UI/Padding/Top", "UI", (n) => (n as UILayoutNode).padding.top),
  def("ui.padding.bottom", "UI/Padding/Bottom", "UI", (n) => (n as UILayoutNode).padding.bottom),
];

/** 节点图最小读取面（解析父节点用；编辑器传 engine.graph） */
interface NodeGraphLike {
  get(id: string): Node | undefined;
}

/** 按节点能力给出可添加的属性组（镜像检查器属性卡片；无能力时不出对应组） */
export function animPropGroupsFor(
  node: Node,
  graph?: NodeGraphLike,
): { group: string; items: AnimPropDef[] }[] {
  const groups: { group: string; items: AnimPropDef[] }[] = [];
  // 变换组：UI 节点没有 3D Transform 卡（2D 卡的旋转/缩放即 rotation.z /
  // scale.x/y），只出这三条；画布节点无变换卡，不出变换组
  if (node instanceof UIWidgetNode) {
    groups.push({ group: "变换", items: UI_2D_TRANSFORM_PROPS });
  } else if (!(node instanceof UICanvasNode)) {
    groups.push({ group: "变换", items: TRANSFORM_PROPS });
  }
  const cap = lightCapOf(node);
  if (cap) groups.push({ group: "灯光", items: lightDefsFor(cap) });
  if (node instanceof CameraNode) groups.push({ group: "相机", items: cameraDefsFor(node) });
  if (node instanceof MeshNode && node.source === "primitive" && node.material) {
    groups.push({ group: "材质", items: MATERIAL_PROPS });
  }
  if (node instanceof UIWidgetNode) {
    // 按实际可动语义出通道：
    // - 位置/尺寸只在点锚点轴生效（拉伸轴改 anchoredPosition/size 无视觉效果）；
    // - 布局容器（mode≠none）的直接子节点位置由布局接管；尺寸仍生效（决定占位格子）；
    // - 排序/字号/间距/内边距按控件卡无条件提供。
    const pointAxis = (axis: "x" | "y"): boolean =>
      Math.abs(node.anchorMax[axis] - node.anchorMin[axis]) < 1e-6;
    const parent = node.parentId && graph ? (graph.get(node.parentId) ?? null) : null;
    const layoutManaged = parent instanceof UILayoutNode && parent.layoutMode !== "none";
    const items: AnimPropDef[] = [];
    if (!layoutManaged && pointAxis("x")) items.push(UI_POS_X);
    if (!layoutManaged && pointAxis("y")) items.push(UI_POS_Y);
    if (pointAxis("x")) items.push(UI_SIZE_W);
    if (pointAxis("y")) items.push(UI_SIZE_H);
    items.push(UI_SORT_ORDER);
    if (node instanceof UITextNode || node instanceof UIButtonNode) items.push(...UI_TEXT_PROPS);
    if (node instanceof UILayoutNode) items.push(...UI_LAYOUT_PROPS);
    groups.push({ group: "UI", items });
  }
  return groups;
}

/** 全量静态目录（按通道键查定义；未知键返回 null）。含全部灯型/投影/UI 控件超集。 */
const ALL_DEFS: AnimPropDef[] = [
  ...TRANSFORM_PROPS,
  ...LIGHT_PROPS,
  ...CAMERA_PROPS,
  ...MATERIAL_PROPS,
  UI_POS_X,
  UI_POS_Y,
  UI_SIZE_W,
  UI_SIZE_H,
  UI_SORT_ORDER,
  ...UI_TEXT_PROPS,
  ...UI_LAYOUT_PROPS,
];

export function propDefOf(prop: string): AnimPropDef | null {
  return ALL_DEFS.find((d) => d.prop === prop) ?? null;
}

/** 目录全路径自然序（动画编辑器轨道树子级排序；未知键排同名末尾） */
export const ANIM_PATHS: readonly string[] = ALL_DEFS.map((d) => d.path);

// —— 添加属性菜单的层级构建（按路径段逐级出子菜单：变换 ▸ 位置 ▸ X） ——

/** 路径段显示名（未登记的段原样展示：X/Y/Z、R/G/B 等轴/分量字母） */
const SEGMENT_LABELS: Record<string, string> = {
  Position: "位置",
  Rotation: "旋转",
  Scale: "缩放",
  Intensity: "强度",
  Color: "颜色",
  Range: "范围",
  Decay: "衰减",
  Angle: "聚光角度",
  Penumbra: "边缘柔和度",
  Fov: "视场角",
  Near: "近裁剪面",
  Far: "远裁剪面",
  Metalness: "金属度",
  Roughness: "粗糙度",
  "Emissive Intensity": "自发光强度",
  Size: "尺寸",
  W: "宽",
  H: "高",
  "Sort Order": "Sort Order",
  "Font Size": "字号",
  Spacing: "间距",
  Padding: "内边距",
  Left: "左",
  Right: "右",
  Top: "上",
  Bottom: "下",
};

export interface MenuTrailSeg {
  /** 原始段（英文，与路径一致） */
  seg: string;
  /** 展示名（中文优先） */
  label: string;
}

/** 通道路径 → 菜单层级段（去掉首段组名；组名由菜单一级分类承担） */
export function defMenuTrail(def: AnimPropDef): MenuTrailSeg[] {
  return def.path
    .split("/")
    .slice(1)
    .map((seg) => ({ seg, label: SEGMENT_LABELS[seg] ?? seg }));
}
