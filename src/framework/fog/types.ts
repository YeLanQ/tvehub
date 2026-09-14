// ---------------------------------------------------------------------------
// 雾数据类型（framework 层，不依赖 app/api）。
//
// 雾节点（FogNode.fog）持有可 JSON 序列化的雾参数：颜色 + 线性雾 near/far +
// 指数雾 density（按 fogKind 取用，全部字段随场景序列化）。读取经
// parseFogSettings 统一收敛（缺失/越界回退默认，旧场景兼容）。
// 编辑器（EditorEngine.applyFogFromGraph）与播放器（public/engine/runtime/fog.mjs）
// 按同一取值域构建 three 的 THREE.Fog / THREE.FogExp2（语义参考 three.js 官网
// fog 示例：颜色即雾色，near→far 线性过渡 / 按距离指数衰减）。
// ---------------------------------------------------------------------------

/** 雾类型：线性雾（THREE.Fog）| 指数雾（THREE.FogExp2）| 高度雾（exp2 基础 + 海拔衰减） */
export type FogKind = "linear" | "exp2" | "height";

/** 全部雾类型（创建菜单/命令层校验共用） */
export const FOG_KINDS: FogKind[] = ["linear", "exp2", "height"];

/**
 * 雾设置（FogNode.fog 的形状；全部字段随场景序列化，按 fogKind 取用）。
 * height 类型复用 color/density 作雾色与基础浓度（exp2 式距离衰减），
 * 叠加海拔衰减：雾带中点（相机与片元中点）海拔高出 heightY 越多雾越薄，
 * heightFalloff 为衰减标度（越大向上衰减越缓）。
 */
export interface FogSettings {
  /** 雾色（RGB hex；远处物体向此色过渡，与背景/天空地平线同色时无缝融合） */
  color: number;
  /** 线性雾起始距离（相机到物体，世界单位；此距离内不受雾影响） */
  near: number;
  /** 线性雾终止距离（此距离外完全为雾色） */
  far: number;
  /** 指数/高度雾密度（越大衰减越快；典型 0.001~0.1） */
  density: number;
  /** 高度雾基准海拔（世界 Y；此高度以下雾最浓） */
  heightY: number;
  /** 高度雾衰减标度（世界单位；雾带中点高出基准面这么多时浓度约剩 1/e） */
  heightFalloff: number;
}

/** 雾默认参数（线性 near/far 与旧场景渲染设置同款；指数密度给可见但不呛人的雾） */
export const DEFAULT_FOG_SETTINGS: FogSettings = {
  color: 0xa0a0a0,
  near: 1,
  far: 100,
  density: 0.02,
  heightY: 0,
  heightFalloff: 20,
};

/** 各数值字段的取值域（检查器钳制 / parse 收敛 / 运行时镜像共用同一份边界） */
export const FOG_LIMITS = {
  near: { min: 0, max: 100000 },
  far: { min: 0, max: 100000 },
  density: { min: 0, max: 1 },
  heightY: { min: -5000, max: 5000 },
  heightFalloff: { min: 0.1, max: 2000 },
} as const;

function clampNum(v: unknown, lo: number, hi: number, fb: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fb;
  return Math.min(hi, Math.max(lo, n));
}

function clampHex(v: unknown, fb: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fb;
  return Math.min(0xffffff, Math.max(0, Math.round(n))) & 0xffffff;
}

/**
 * 收敛雾设置（缺字段/越界/非法类型回退默认或钳进取值域）。
 * 场景 JSON 反序列化与检查器写入共用这一边界，保证取值域单一事实源。
 */
export function parseFogSettings(v: unknown): FogSettings {
  const d = DEFAULT_FOG_SETTINGS;
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const L = FOG_LIMITS;
  return {
    color: clampHex(o.color, d.color),
    near: clampNum(o.near, L.near.min, L.near.max, d.near),
    far: clampNum(o.far, L.far.min, L.far.max, d.far),
    density: clampNum(o.density, L.density.min, L.density.max, d.density),
    heightY: clampNum(o.heightY, L.heightY.min, L.heightY.max, d.heightY),
    heightFalloff: clampNum(o.heightFalloff, L.heightFalloff.min, L.heightFalloff.max, d.heightFalloff),
  };
}

/** 深拷贝（节点克隆/整节点快照用） */
export function cloneFogSettings(v: FogSettings): FogSettings {
  return { ...v };
}

/**
 * 重建签名（设置 → 字符串）：引擎据此判断是否需要重建 scene.fog 对象。
 * 全字段参与：任何设置变化都换一个雾实例（three 按雾引用差异自动重编译材质）。
 */
export function fogSettingsSig(s: FogSettings): string {
  return [s.color, s.near, s.far, s.density, s.heightY, s.heightFalloff].join("|");
}

/** 雾类型显示名（菜单/检查器共用） */
export function fogKindLabel(kind: FogKind): string {
  return kind === "exp2" ? "Exponential Fog" : kind === "height" ? "Height Fog" : "Linear Fog";
}
