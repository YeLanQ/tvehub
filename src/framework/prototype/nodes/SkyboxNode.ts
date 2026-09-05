import { Node, type NodeInit } from "../Node";
import { cloneRecord } from "../types";

/** 天空盒类型：程序化天空 / 立方体天空盒 */
export type SkyboxKind = "procedural" | "cube";

/** 内置程序化天空盒材质（internal 只读，定义该类型天空的默认参数） */
export const PROCEDURAL_SKY_MATERIAL_REL = "internal/materials/ProceduralSky.mat";
/** 内置立方体天空盒材质（internal 只读，定义该类型天空的默认参数） */
export const SKYBOX_MATERIAL_REL = "internal/materials/SkyBox.mat";

/** 每种天空盒类型固定的内置材质引用 */
export function skyMaterialForKind(kind: SkyboxKind): string {
  return kind === "procedural" ? PROCEDURAL_SKY_MATERIAL_REL : SKYBOX_MATERIAL_REL;
}

export interface SkyboxNodeInit extends NodeInit {
  skyKind?: SkyboxKind;
  /** 天空盒材质资产引用（内置 internal/…；创建时按类型固定，不可切换） */
  material?: string;
  /** 顶部颜色（程序化=天空顶部；立方体=顶面） */
  topColor?: number;
  /** 地平线颜色（程序化=地平线；立方体=四个侧面） */
  horizonColor?: number;
  /** 下方颜色（程序化=地面以下；立方体=底面） */
  groundColor?: number;
}

/** 天空盒默认配色：明亮晴空（顶→地平线→下方；与内置材质文件一致） */
export const DEFAULT_SKYBOX_COLORS = {
  top: 0x2f6fbb,
  horizon: 0xcfe4f7,
  ground: 0x8fa2b5,
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
  topColor: number = DEFAULT_SKYBOX_COLORS.top;
  horizonColor: number = DEFAULT_SKYBOX_COLORS.horizon;
  groundColor: number = DEFAULT_SKYBOX_COLORS.ground;

  constructor(init: SkyboxNodeInit = {}) {
    super(init);
    this.skyKind = init.skyKind ?? this.skyKind;
    this.material = init.material ?? skyMaterialForKind(this.skyKind);
    this.topColor = init.topColor ?? this.topColor;
    this.horizonColor = init.horizonColor ?? this.horizonColor;
    this.groundColor = init.groundColor ?? this.groundColor;
  }

  override clone(): SkyboxNode {
    return new SkyboxNode({
      name: this.name,
      transform: this.transform,
      properties: cloneRecord(this.properties),
      skyKind: this.skyKind,
      material: this.material,
      topColor: this.topColor,
      horizonColor: this.horizonColor,
      groundColor: this.groundColor,
    });
  }

  protected override writeOwnData(target: Record<string, unknown>): void {
    target.skyKind = this.skyKind;
    target.material = this.material;
    target.topColor = this.topColor;
    target.horizonColor = this.horizonColor;
    target.groundColor = this.groundColor;
  }

  protected override readOwnData(source: Record<string, unknown>): void {
    const kind = source.skyKind as SkyboxKind | undefined;
    if (kind === "procedural" || kind === "cube") this.skyKind = kind;
    // 兼容旧场景：缺 material 时按当前类型回退对应的内置天空盒材质
    this.material =
      (source.material as string) ?? skyMaterialForKind(this.skyKind);
    this.topColor = (source.topColor as number) ?? this.topColor;
    this.horizonColor = (source.horizonColor as number) ?? this.horizonColor;
    this.groundColor = (source.groundColor as number) ?? this.groundColor;
  }

  static fromJSON(json: Record<string, unknown>): SkyboxNode {
    const node = new SkyboxNode();
    node.applyJSON(json);
    return node;
  }
}
