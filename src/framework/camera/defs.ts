// 相机参数面板定义（风格对齐 material/defs.ts，命名参照通用相机属性）：
// 供 CameraSection 数据驱动渲染；公共分组（near/far）任何类型都显示，
// 类型特有分组（透视 fov / 正交 orthoSize）由工厂类型定义各自给出。
import type { CameraParamKey, CameraClearFlags } from "./types";

export interface CameraParamDef {
  key: CameraParamKey;
  /** 中文显示名 */
  label: string;
  /** three 英文属性名（提示） */
  en: string;
  /** 数值步进（拖动调节灵敏度；缺省 0.01） */
  step?: number;
  /** 允许的最小值（缺省不限） */
  min?: number;
  /** 允许的最大值（缺省不限） */
  max?: number;
}

/** 清除标志选项定义（相机属性面板下拉；渲染（Rendering）分组用） */
export interface CameraClearFlagDef {
  key: CameraClearFlags;
  /** 中文显示名 */
  label: string;
  /** 引擎英文属性名（提示） */
  en: string;
  /** 行为说明（下拉 title 提示） */
  desc: string;
}

/** 清除标志选项（顺序 = 下拉展示顺序） */
export const CAMERA_CLEAR_FLAG_DEFS: CameraClearFlagDef[] = [
  {
    key: "skybox",
    label: "天空盒",
    en: "Skybox",
    desc: "清空颜色+深度缓冲并绘制天空盒（无天空盒节点时回退编辑器底色）",
  },
  {
    key: "solidColor",
    label: "纯色",
    en: "Solid Color",
    desc: "清空颜色+深度缓冲并以纯色填充背景",
  },
  {
    key: "depthOnly",
    label: "仅深度",
    en: "Depth Only",
    desc: "只清空深度缓冲、保留上一帧颜色（不清颜色，画面逐帧叠加）",
  },
  {
    key: "colorOnly",
    label: "仅颜色",
    en: "Color Only",
    desc: "只清空颜色缓冲、保留上一帧深度（不清深度）",
  },
];

export interface CameraParamGroup {
  /** 分组标题 */
  title: string;
  defs: CameraParamDef[];
}

/** 公共参数定义（near/far；任何相机类型都显示） */
const COMMON_DEFS: CameraParamDef[] = [
  { key: "near", label: "近裁剪面", en: "Clip Start", step: 0.001, min: 0.01 },
  { key: "far", label: "远裁剪面", en: "Clip End", step: 0.5, min: 1 },
];

/** 公共参数分组（所有相机类型都显示；near/far） */
export const COMMON_CAMERA_PARAM_GROUPS: CameraParamGroup[] = [
  { title: "公共（Common）", defs: COMMON_DEFS },
];

const FLAT: Record<CameraParamKey, CameraParamDef> = {
  near: COMMON_DEFS[0],
  far: COMMON_DEFS[1],
  fov: { key: "fov", label: "视场角", en: "Field of View（deg）", step: 1, min: 1, max: 170 },
  orthoSize: {
    key: "orthoSize",
    label: "正交半高",
    en: "Orthographic Size（取景高度的一半，世界单位）",
    step: 0.1,
    min: 0.01,
  },
};

/** 按字段名取参数定义（命令标签等场景用） */
export function cameraParamDef(key: CameraParamKey): CameraParamDef {
  return FLAT[key];
}
