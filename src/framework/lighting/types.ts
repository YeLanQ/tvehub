// ---------------------------------------------------------------------------
// 灯光组件数据类型（framework 层，不依赖 app 与 three）。
//
// 灯光组件（节点 components 中 type="light" 的引用）持有可 JSON 序列化的
// 灯光设置：类型（点光/平行光/聚光灯/环境光）+ 颜色强度 + 各类型参数。
// 与灯光节点（PointLightNode 等类层级）的区别：组件可挂任意节点（组件模式，
// 同节点还可再挂脚本/物理等），节点类型仍是"一种渲染体"的旧语义，两者并存。
// 读取经 parseLightComponentSettings 统一收敛（缺失/越界字段回退默认）。
// ---------------------------------------------------------------------------

/** 灯光类型（与 LightNode 的 LightKind 同一取值集） */
export type LightComponentKind = "point" | "directional" | "ambient" | "spot";

/** 灯光组件设置（节点上灯光组件的形状；各类型共用一个扁平结构） */
export interface LightComponentSettings {
  /** 灯光类型（切换即重建渲染侧灯光对象） */
  kind: LightComponentKind;
  /** 光色（0xRRGGBB） */
  lightColor: number;
  /** 强度 */
  intensity: number;
  /** 点光/聚光灯：照射距离（0 = 无限远） */
  distance: number;
  /** 点光/聚光灯：物理衰减指数 */
  decay: number;
  /** 聚光灯：光束半角（度） */
  angle: number;
  /** 聚光灯：边缘柔和度 0~1 */
  penumbra: number;
  /** 点光/平行光/聚光灯：投射阴影 */
  castShadow: boolean;
  /** 阴影浓度 0~1（点光/平行光/聚光灯生效；Unity Strength） */
  shadowStrength: number;
  /** 阴影深度偏移（压制自阴影麻点；Unity Bias） */
  shadowBias: number;
  /** 阴影法线偏移（≤0 = 自动按阴影贴图纹素相对化；Unity Normal Bias） */
  shadowNormalBias: number;
  /** 阴影近裁剪面（比这更近的物体不参与投影；Unity Near Plane） */
  shadowNear: number;
  /** 阴影软化半径（PCF 采样核，1 = 硬阴影；检查器 Shadow 类型下拉的 Soft = 4） */
  shadowRadius: number;
}

export const DEFAULT_LIGHT_COMPONENT_SETTINGS: LightComponentSettings = {
  kind: "point",
  lightColor: 0xffffff,
  intensity: 1,
  distance: 0,
  decay: 2,
  angle: 45,
  penumbra: 0.2,
  castShadow: false,
  shadowStrength: 1,
  shadowBias: -0.0005,
  shadowNormalBias: 0,
  shadowNear: 0.1,
  shadowRadius: 4,
};

function str(v: unknown, fb: string): string {
  return typeof v === "string" ? v : fb;
}
function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 任意来源 → 收敛的灯光组件设置（缺失/非法字段回退默认） */
export function parseLightComponentSettings(v: unknown): LightComponentSettings {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const d = DEFAULT_LIGHT_COMPONENT_SETTINGS;
  const kind = str(o.kind, d.kind);
  return {
    kind: (["point", "directional", "ambient", "spot"] as const).includes(
      kind as LightComponentKind,
    )
      ? (kind as LightComponentKind)
      : d.kind,
    lightColor: num(o.lightColor, d.lightColor) & 0xffffff,
    intensity: Math.max(0, num(o.intensity, d.intensity)),
    distance: Math.max(0, num(o.distance, d.distance)),
    decay: clamp(num(o.decay, d.decay), 0, 10),
    angle: clamp(num(o.angle, d.angle), 0.1, 89.9),
    penumbra: clamp(num(o.penumbra, d.penumbra), 0, 1),
    castShadow: o.castShadow === true,
    shadowStrength: clamp(num(o.shadowStrength, d.shadowStrength), 0, 1),
    shadowBias: Math.max(-0.05, Math.min(0, num(o.shadowBias, d.shadowBias))),
    shadowNormalBias: Math.max(0, num(o.shadowNormalBias, d.shadowNormalBias)),
    shadowNear: Math.max(0.01, num(o.shadowNear, d.shadowNear)),
    shadowRadius: clamp(num(o.shadowRadius, d.shadowRadius), 1, 5),
  };
}

/** 深拷贝灯光组件设置（节点克隆/组件复制用） */
export function cloneLightComponentSettings(s: LightComponentSettings): LightComponentSettings {
  return { ...s };
}
