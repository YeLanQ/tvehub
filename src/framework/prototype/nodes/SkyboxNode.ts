import { Node, type NodeInit } from "../Node";
import { cloneRecord } from "../types";

/** 天空盒类型：程序化天空 / 立方体天空盒 */
export type SkyboxKind = "procedural" | "cube";

/** 程序化天空的太阳盘模式 */
export type SkySunDisk = "high" | "simple" | "none";

/** 内置程序化天空盒材质（internal 只读，定义该类型天空的默认参数） */
export const PROCEDURAL_SKY_MATERIAL_REL = "internal/materials/ProceduralSky.mat";
/** 内置立方体天空盒材质（internal 只读，定义该类型天空的默认参数） */
export const SKYBOX_MATERIAL_REL = "internal/materials/SkyBox.mat";
/** 内置默认 TextureCube 资产（立方体天空盒默认贴图；等距柱状全景图） */
export const DEFAULT_TEXCUBE_REL = "internal/skybox/DefaultSkybox.texcube";

/** 每种天空盒类型固定的内置材质引用 */
export function skyMaterialForKind(kind: SkyboxKind): string {
  return kind === "procedural" ? PROCEDURAL_SKY_MATERIAL_REL : SKYBOX_MATERIAL_REL;
}

export interface SkyboxNodeInit extends NodeInit {
  skyKind?: SkyboxKind;
  /** 天空盒材质资产引用（内置 internal/…；创建时按类型固定，不可切换） */
  material?: string;
  /** 立方体天空盒的 TextureCube 资产引用（.texcube；仅 skyKind=cube 生效） */
  cubeMap?: string;
  /** 顶部颜色（程序化=天空顶部；立方体=顶面） */
  topColor?: number;
  /** 地平线颜色（程序化=地平线；立方体=四个侧面） */
  horizonColor?: number;
  /** 下方颜色（程序化=地面以下；立方体=底面） */
  groundColor?: number;
  // —— 程序化天空太阳参数（仅 procedural 生效）——
  sunDisk?: SkySunDisk;
  /** 太阳颜色（RGB hex number；默认暖白偏黄） */
  sunColor?: number;
  /** 太阳大小（半径，度） */
  sunSize?: number;
  /** 光晕强度（0~1；光晕大小与透明度随强度缩放，颜色与太阳颜色一致） */
  sunGlow?: number;
  /** 太阳方位角（度；0 = +X 方向，逆时针转正） */
  sunAzimuth?: number;
  /** 太阳仰角（度；0 = 地平线，向上为正） */
  sunElevation?: number;
}

/** 天空盒默认配色：明亮晴空（顶→地平线→下方；与内置材质文件一致） */
export const DEFAULT_SKYBOX_COLORS = {
  top: 0x2f6fbb,
  horizon: 0xcfe4f7,
  ground: 0x8fa2b5,
} as const;

/** 程序化天空默认太阳参数 */
export const DEFAULT_SUN = {
  disk: "high" as SkySunDisk,
  color: 0xffd27d,
  size: 3,
  glow: 0.8,
  azimuth: 90,
  elevation: 25,
} as const;

/**
 * 天空盒节点：场景环境级节点（不属于实体网格）。
 * 场景中第一个"启用且可见"的天空盒节点决定渲染场景背景：
 * - procedural（程序化天空盒）：生成等距柱状渐变纹理作为 scene.background；
 * - cube（立方体天空盒）：六面贴图背景（顶/侧/底）。
 * 类型在创建时由菜单固定（内置材质 ProceduralSky.mat / SkyBox.mat），不可切换。
 */
export class SkyboxNode extends Node {
  static override readonly kType: string = "skyboxNode";
  override readonly typeKey: string = SkyboxNode.kType;

  skyKind: SkyboxKind = "procedural";
  /** 该天空盒使用的材质资产引用（按类型固定：程序化→ProceduralSky.mat；立方体→SkyBox.mat） */
  material: string = PROCEDURAL_SKY_MATERIAL_REL;
  /** 立方体天空盒贴图（TextureCube 资产引用；仅 cube 生效，缺失/加载失败回退三段色带） */
  cubeMap: string = DEFAULT_TEXCUBE_REL;
  topColor: number = DEFAULT_SKYBOX_COLORS.top;
  horizonColor: number = DEFAULT_SKYBOX_COLORS.horizon;
  groundColor: number = DEFAULT_SKYBOX_COLORS.ground;
  // —— 程序化天空太阳参数（仅 procedural 生效）——
  sunDisk: SkySunDisk = DEFAULT_SUN.disk;
  sunColor: number = DEFAULT_SUN.color;
  sunSize: number = DEFAULT_SUN.size;
  sunGlow: number = DEFAULT_SUN.glow;
  sunAzimuth: number = DEFAULT_SUN.azimuth;
  sunElevation: number = DEFAULT_SUN.elevation;

  constructor(init: SkyboxNodeInit = {}) {
    super(init);
    this.skyKind = init.skyKind ?? this.skyKind;
    this.material = init.material ?? skyMaterialForKind(this.skyKind);
    this.cubeMap = init.cubeMap ?? this.cubeMap;
    this.topColor = init.topColor ?? this.topColor;
    this.horizonColor = init.horizonColor ?? this.horizonColor;
    this.groundColor = init.groundColor ?? this.groundColor;
    if (init.sunDisk === "high" || init.sunDisk === "simple" || init.sunDisk === "none") {
      this.sunDisk = init.sunDisk;
    }
    this.sunColor = init.sunColor ?? this.sunColor;
    this.sunSize = init.sunSize ?? this.sunSize;
    this.sunGlow = init.sunGlow ?? this.sunGlow;
    this.sunAzimuth = init.sunAzimuth ?? this.sunAzimuth;
    this.sunElevation = init.sunElevation ?? this.sunElevation;
  }

  override clone(): SkyboxNode {
    return new SkyboxNode({
      name: this.name,
      transform: this.transform,
      properties: cloneRecord(this.properties),
      tag: this.tag,
      prefab: this.prefab,
      components: this.components,
      skyKind: this.skyKind,
      material: this.material,
      cubeMap: this.cubeMap,
      topColor: this.topColor,
      horizonColor: this.horizonColor,
      groundColor: this.groundColor,
      sunDisk: this.sunDisk,
      sunColor: this.sunColor,
      sunSize: this.sunSize,
      sunGlow: this.sunGlow,
      sunAzimuth: this.sunAzimuth,
      sunElevation: this.sunElevation,
    });
  }

  protected override writeOwnData(target: Record<string, unknown>): void {
    target.skyKind = this.skyKind;
    target.material = this.material;
    target.cubeMap = this.cubeMap;
    target.topColor = this.topColor;
    target.horizonColor = this.horizonColor;
    target.groundColor = this.groundColor;
    target.sunDisk = this.sunDisk;
    target.sunColor = this.sunColor;
    target.sunSize = this.sunSize;
    target.sunGlow = this.sunGlow;
    target.sunAzimuth = this.sunAzimuth;
    target.sunElevation = this.sunElevation;
  }

  protected override readOwnData(source: Record<string, unknown>): void {
    const kind = source.skyKind as SkyboxKind | undefined;
    if (kind === "procedural" || kind === "cube") this.skyKind = kind;
    // 兼容旧场景：缺 material 时按当前类型回退对应的内置天空盒材质
    this.material =
      (source.material as string) ?? skyMaterialForKind(this.skyKind);
    // 兼容旧场景：缺 cubeMap 时回退内置默认 TextureCube（仅 cube 类型消费该字段）
    this.cubeMap = (source.cubeMap as string) ?? DEFAULT_TEXCUBE_REL;
    this.topColor = (source.topColor as number) ?? this.topColor;
    this.horizonColor = (source.horizonColor as number) ?? this.horizonColor;
    this.groundColor = (source.groundColor as number) ?? this.groundColor;
    const disk = source.sunDisk as SkySunDisk | undefined;
    if (disk === "high" || disk === "simple" || disk === "none") this.sunDisk = disk;
    this.sunColor = (source.sunColor as number) ?? this.sunColor;
    this.sunSize = (source.sunSize as number) ?? this.sunSize;
    this.sunGlow = (source.sunGlow as number) ?? this.sunGlow;
    this.sunAzimuth = (source.sunAzimuth as number) ?? this.sunAzimuth;
    this.sunElevation = (source.sunElevation as number) ?? this.sunElevation;
  }

  static fromJSON(json: Record<string, unknown>): SkyboxNode {
    const node = new SkyboxNode();
    node.applyJSON(json);
    return node;
  }
}
