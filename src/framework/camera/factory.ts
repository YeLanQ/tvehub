// ---------------------------------------------------------------------------
// 相机类型工厂（注册表模式，风格对齐 material/factory.ts）：
// - 每种相机类型对应一个 CameraTypeDef：UI 参数分组、默认参数、
//   视锥尺寸推导都收敛在类型定义内；
// - 需要新相机类型时：写一个 CameraTypeDef 并在 createDefaultCameraTypeRegistry
//   里 register 一行即可；
// - CameraNode.cameraType 字段（缺省 perspective）→ 注册表查找类型定义；
// - 参数是全部类型的超集（fov/orthoSize 共存于节点），切换类型保留另一类型的值。
// ---------------------------------------------------------------------------

import {
  DEFAULT_CAMERA_PARAMS,
  DEFAULT_CAMERA_TYPE,
  type CameraKind,
} from "./types";
import type { CameraParamGroup } from "./defs";

/** 视锥几何参数（推导辅助线/真实相机取景共用） */
export interface CameraFrustumSource {
  fov: number;
  orthoSize: number;
}

/** 单个相机类型的完整定义（UI 分组 + 视锥推导规则） */
export interface CameraTypeDef {
  /** 类型 key（CameraNode.cameraType 字段） */
  key: CameraKind;
  /** UI 显示名（相机属性面板类型下拉） */
  label: string;
  /** 该类型特有参数的分组（公共分组之外追加显示；渲染分组 = 公共 + 特有） */
  paramGroups: CameraParamGroup[];
  /** 该类型的默认参数（新建相机/回退用；返回超集的一份拷贝） */
  defaultParams(): Record<string, number>;
  /**
   * 视锥在给定深度处的半宽/半高（相机局部空间）：
   * 透视按 fov 推导（近小远大），正交恒为 orthoSize（长方体）。
   * 辅助线与预览相机共用此规则，保证线框 = 实际取景。
   */
  frustumHalfSize(
    params: CameraFrustumSource,
    depth: number,
    aspect: number,
  ): { halfW: number; halfH: number };
}

/** 相机类型注册表：key → 类型定义 */
export class CameraTypeRegistry {
  private defs = new Map<string, CameraTypeDef>();

  register(def: CameraTypeDef): void {
    this.defs.set(def.key, def);
  }

  /** 按类型 key 取定义；未注册返回 null */
  get(key: string): CameraTypeDef | null {
    return this.defs.get(key) ?? null;
  }

  /** 按类型 key 取定义；未注册/未知回退默认类型（保证渲染不中断） */
  getOrDefault(key: string): CameraTypeDef {
    return this.defs.get(key) ?? this.defs.get(DEFAULT_CAMERA_TYPE)!;
  }

  /** 已注册类型列表（注册顺序 = UI 展示顺序） */
  list(): CameraTypeDef[] {
    return [...this.defs.values()];
  }
}

// ---------------------------------------------------------------------------
// 透视（perspective）：fov 决定取景，近小远大的四棱锥台；
// 参数与默认值即 CameraNode 自身的既有行为。
// ---------------------------------------------------------------------------

const PERSPECTIVE_PARAM_GROUPS: CameraParamGroup[] = [
  {
    title: "透视（Perspective）",
    defs: [
      { key: "fov", label: "视场角", en: "Field of View（deg）", step: 1, min: 1, max: 170 },
    ],
  },
];

const PERSPECTIVE_DEF: CameraTypeDef = {
  key: "perspective",
  label: "透视（Perspective）",
  paramGroups: PERSPECTIVE_PARAM_GROUPS,
  defaultParams: () => ({ ...DEFAULT_CAMERA_PARAMS }),
  frustumHalfSize: (params, depth, aspect) => {
    const tanHalf = Math.tan((params.fov * Math.PI) / 360);
    const halfH = tanHalf * depth;
    return { halfW: halfH * aspect, halfH };
  },
};

// ---------------------------------------------------------------------------
// 正交（orthographic）：无近大远小，取景为固定尺寸的长方体；
// orthoSize = 取景高度的一半（世界单位），宽度 = orthoSize × 宽高比。
// ---------------------------------------------------------------------------

const ORTHOGRAPHIC_PARAM_GROUPS: CameraParamGroup[] = [
  {
    title: "正交（Orthographic）",
    defs: [
      {
        key: "orthoSize",
        label: "正交半高",
        en: "Orthographic Size（取景高度的一半，世界单位）",
        step: 0.1,
        min: 0.01,
      },
    ],
  },
];

const ORTHOGRAPHIC_DEF: CameraTypeDef = {
  key: "orthographic",
  label: "正交（Orthographic）",
  paramGroups: ORTHOGRAPHIC_PARAM_GROUPS,
  defaultParams: () => ({ ...DEFAULT_CAMERA_PARAMS }),
  frustumHalfSize: (params, _depth, aspect) => {
    const halfH = Math.max(0.01, params.orthoSize);
    return { halfW: halfH * aspect, halfH };
  },
};

/** 默认相机类型注册表（perspective + orthographic；新类型在此追加一行 register） */
export function createDefaultCameraTypeRegistry(): CameraTypeRegistry {
  const registry = new CameraTypeRegistry();
  registry.register(PERSPECTIVE_DEF);
  registry.register(ORTHOGRAPHIC_DEF);
  return registry;
}

/** 模块级单例：类型定义无状态，引擎同步与 UI（类型下拉/参数分组/辅助线）共用 */
export const cameraTypeRegistry = createDefaultCameraTypeRegistry();
