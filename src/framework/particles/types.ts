// ---------------------------------------------------------------------------
// 粒子系统数据类型（framework 层，不依赖 app/api 与 three）。
//
// 粒子系统节点（ParticleSystemNode.particles）持有可 JSON 序列化的发射设置
// （Unity ParticleSystem 的 Main / Emission / Shape / Color & Size over Lifetime /
// Renderer 子集）。读取时经 parseParticleSystemSettings 统一收敛（缺失/越界字段
// 回退默认），保证旧场景兼容；编辑器（ParticleEmitter）与播放器
// （public/engine/core/particles.mjs）按同一取值域模拟渲染。
// ---------------------------------------------------------------------------

/** 发射形状：cone = 圆锥（沿节点本地 -Z，与灯光/相机前向同语义）| sphere = 球面 | hemisphere = 上半球 | box = 盒体（沿 -Z 发射） */
export type ParticleShapeKind = "cone" | "sphere" | "hemisphere" | "box";

/** 混合模式：additive = 叠加（火焰/魔法，越叠越亮）| normal = 常规透明混合（烟雾/雨雪） */
export type ParticleBlendMode = "additive" | "normal";

/** 模拟空间：local = 粒子跟随节点移动 | world = 粒子留在世界空间（拖尾/烟迹） */
export type ParticleSimulationSpace = "local" | "world";

/** 粒子贴图可用的图片资产扩展名（小写；与材质贴图通道同一集合） */
export const PARTICLE_TEXTURE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tga", "svg"] as const;

/** 是否可作粒子贴图的图片资产相对路径（按扩展名判断） */
export function isParticleTextureRel(rel: string): boolean {
  const i = rel.lastIndexOf(".");
  if (i < 0) return false;
  return (PARTICLE_TEXTURE_EXTS as readonly string[]).includes(rel.slice(i + 1).toLowerCase());
}

/** 粒子系统发射设置（ParticleSystemNode.particles 的形状） */
export interface ParticleSystemSettings {
  /** 发射周期（秒）：非循环系统发射持续该时长后停止；循环系统作为预热（prewarm）快进量 */
  duration: number;
  /** 循环发射 */
  looping: boolean;
  /** 预热：入图/重启时快进一个周期，粒子瞬间就位（仅循环系统生效） */
  prewarm: boolean;
  /** 起始延迟（秒）：播放后延迟该时长再开始发射 */
  startDelay: number;
  /** 粒子寿命（秒） */
  startLifetime: number;
  /** 初速度（世界单位/秒） */
  startSpeed: number;
  /** 初始尺寸（世界单位；billboard 直径） */
  startSize: number;
  /** 初始颜色（RGB hex） */
  startColor: number;
  /** 终点颜色（RGB hex；colorOverLifetime 开启时按寿命进度从 startColor 插值到该色） */
  endColor: number;
  /** 重力系数（1 = 标准重力 9.81；0 = 无重力；负值上浮） */
  gravityModifier: number;
  /** 发射速率（粒子/秒） */
  emissionRate: number;
  /** 同时存活的粒子上限（缓冲区容量；到上限后新粒子排队等待旧粒子消亡） */
  maxParticles: number;
  /** 发射形状 */
  shape: ParticleShapeKind;
  /** 形状半径（cone 底圆半径 / sphere、hemisphere 球半径 / box 半边长） */
  shapeRadius: number;
  /** 圆锥张角（度，半角；仅 cone 生效） */
  shapeAngle: number;
  /** 模拟空间 */
  simulationSpace: ParticleSimulationSpace;
  /** 颜色随寿命：startColor → endColor 插值 + 末段淡出 */
  colorOverLifetime: boolean;
  /** 尺寸随寿命：startSize 线性缩到 0 */
  sizeOverLifetime: boolean;
  /** 混合模式 */
  blending: ParticleBlendMode;
  /**
   * 粒子贴图（图片资产相对路径；空串 = 内置程序化软圆点）。
   * 贴图 RGB 与粒子颜色相乘、alpha 与粒子透明度相乘（白底透明 PNG 即"着色精灵"）。
   * 缺失/加载失败回退内置软圆点。
   */
  texture: string;
}

export const DEFAULT_PARTICLE_SETTINGS: ParticleSystemSettings = {
  duration: 5,
  looping: true,
  prewarm: false,
  startDelay: 0,
  startLifetime: 2,
  startSpeed: 3,
  startSize: 0.3,
  startColor: 0xffb060,
  endColor: 0xff3020,
  gravityModifier: 0,
  emissionRate: 20,
  maxParticles: 500,
  shape: "cone",
  shapeRadius: 0.5,
  shapeAngle: 25,
  simulationSpace: "local",
  colorOverLifetime: true,
  sizeOverLifetime: true,
  blending: "additive",
  texture: "",
};

/** 各数值字段的取值域（检查器钳制 / parse 收敛 / 运行时镜像共用同一份边界） */
export const PARTICLE_LIMITS = {
  duration: { min: 0.05, max: 600 },
  startDelay: { min: 0, max: 60 },
  startLifetime: { min: 0.05, max: 120 },
  startSpeed: { min: 0, max: 200 },
  startSize: { min: 0.01, max: 100 },
  gravityModifier: { min: -20, max: 20 },
  emissionRate: { min: 0, max: 5000 },
  maxParticles: { min: 1, max: 20000 },
  shapeRadius: { min: 0, max: 500 },
  shapeAngle: { min: 0, max: 89 },
} as const;

/** 粒子系统运行时状态快照（检查器展示 / SDK 查询用） */
export interface ParticleRuntimeState {
  /** 正在推进（未暂停） */
  playing: boolean;
  /** 已暂停（保留当前粒子） */
  paused: boolean;
  /** 非循环系统已发射完毕且粒子全部消亡 */
  finished: boolean;
  /** 当前存活粒子数 */
  alive: number;
  /** 系统时间（秒；自播放起累计，含起始延迟） */
  time: number;
}

function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}
function bool(v: unknown, fb: boolean): boolean {
  return typeof v === "boolean" ? v : fb;
}
function str(v: unknown, fb = ""): string {
  return typeof v === "string" ? v : fb;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function hexColor(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? (Math.round(v) & 0xffffff) >>> 0 : fb;
}

/** 任意来源 → 收敛的粒子系统设置（缺失/非法字段回退默认；越界钳到取值域） */
export function parseParticleSystemSettings(v: unknown): ParticleSystemSettings {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const d = DEFAULT_PARTICLE_SETTINGS;
  const L = PARTICLE_LIMITS;
  const shape: ParticleShapeKind =
    o.shape === "sphere" || o.shape === "hemisphere" || o.shape === "box" || o.shape === "cone"
      ? o.shape
      : d.shape;
  return {
    duration: clamp(num(o.duration, d.duration), L.duration.min, L.duration.max),
    looping: bool(o.looping, d.looping),
    prewarm: bool(o.prewarm, d.prewarm),
    startDelay: clamp(num(o.startDelay, d.startDelay), L.startDelay.min, L.startDelay.max),
    startLifetime: clamp(num(o.startLifetime, d.startLifetime), L.startLifetime.min, L.startLifetime.max),
    startSpeed: clamp(num(o.startSpeed, d.startSpeed), L.startSpeed.min, L.startSpeed.max),
    startSize: clamp(num(o.startSize, d.startSize), L.startSize.min, L.startSize.max),
    startColor: hexColor(o.startColor, d.startColor),
    endColor: hexColor(o.endColor, d.endColor),
    gravityModifier: clamp(
      num(o.gravityModifier, d.gravityModifier),
      L.gravityModifier.min,
      L.gravityModifier.max,
    ),
    emissionRate: clamp(num(o.emissionRate, d.emissionRate), L.emissionRate.min, L.emissionRate.max),
    maxParticles: Math.round(
      clamp(num(o.maxParticles, d.maxParticles), L.maxParticles.min, L.maxParticles.max),
    ),
    shape,
    shapeRadius: clamp(num(o.shapeRadius, d.shapeRadius), L.shapeRadius.min, L.shapeRadius.max),
    shapeAngle: clamp(num(o.shapeAngle, d.shapeAngle), L.shapeAngle.min, L.shapeAngle.max),
    simulationSpace: o.simulationSpace === "world" ? "world" : "local",
    colorOverLifetime: bool(o.colorOverLifetime, d.colorOverLifetime),
    sizeOverLifetime: bool(o.sizeOverLifetime, d.sizeOverLifetime),
    blending: o.blending === "normal" ? "normal" : "additive",
    texture: str(o.texture),
  };
}

/** 深拷贝粒子设置（节点克隆/编辑工作副本） */
export function cloneParticleSystemSettings(s: ParticleSystemSettings): ParticleSystemSettings {
  return { ...s };
}

/**
 * 结构签名：变化时必须重建渲染对象（缓冲容量 / 混合模式决定几何缓冲与材质），
 * 其余字段可在不重置已存活粒子的前提下原地更新（检查器拖滑块不闪断）。
 * 贴图不属结构参数：换贴图只需替换材质采样 uniform（异步加载完成后热替换）。
 */
export function particleStructureSignature(s: ParticleSystemSettings): string {
  return `${s.maxParticles}|${s.blending}`;
}
