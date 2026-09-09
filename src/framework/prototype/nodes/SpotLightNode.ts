import { cloneRecord } from "../types";
import { LightNode, type LightNodeInit, type ILightNode } from "./LightNode";

/** 聚光灯能力接口：距离/衰减/角度/半影/阴影 */
export interface ISpotLightNode extends ILightNode {
  /** 光束有效距离（0 = 无限远） */
  distance: number;
  /** 物理衰减指数 */
  decay: number;
  /** 光束半角（度，界面友好单位；映射到 three 的 angle 弧度） */
  angle: number;
  /** 边缘柔和度 0~1 */
  penumbra: number;
  castShadow: boolean;
}

/** 聚光灯光源：沿节点本地 -Z 发射的圆锥光束，可配角度/半影/距离/衰减/阴影。 */
export class SpotLightNode extends LightNode implements ISpotLightNode {
  static override readonly kType: string = "spotLightNode";
  override readonly typeKey: string = SpotLightNode.kType;
  readonly lightKind = "spot" as const;

  /** 光束有效距离（0 = 无限远） */
  distance = 0;
  /** 物理衰减指数 */
  decay = 2;
  /** 光束半角（度，界面友好单位；映射到 three 的 angle 弧度） */
  angle = 45;
  /** 边缘柔和度 0~1 */
  penumbra = 0.2;
  castShadow = false;

  constructor(
    init: LightNodeInit & {
      distance?: number;
      decay?: number;
      angle?: number;
      penumbra?: number;
      castShadow?: boolean;
    } = {},
  ) {
    super(init);
    this.distance = init.distance ?? this.distance;
    this.decay = init.decay ?? this.decay;
    this.angle = init.angle ?? this.angle;
    this.penumbra = init.penumbra ?? this.penumbra;
    this.castShadow = init.castShadow ?? this.castShadow;
  }

  override clone(): SpotLightNode {
    const node = new SpotLightNode({
      name: this.name,
      transform: this.transform,
      properties: cloneRecord(this.properties),
      tag: this.tag,
      prefab: this.prefab,
      components: this.components,
      intensity: this.intensity,
      lightColor: this.lightColor,
    });
    node.distance = this.distance;
    node.decay = this.decay;
    node.angle = this.angle;
    node.penumbra = this.penumbra;
    node.castShadow = this.castShadow;
    return node;
  }

  protected override writeOwnData(target: Record<string, unknown>): void {
    this.writeCommon(target);
    target.distance = this.distance;
    target.decay = this.decay;
    target.angle = this.angle;
    target.penumbra = this.penumbra;
    target.castShadow = this.castShadow;
  }

  protected override readOwnData(source: Record<string, unknown>): void {
    this.readCommon(source);
    this.distance = (source.distance as number) ?? this.distance;
    this.decay = (source.decay as number) ?? this.decay;
    this.angle = (source.angle as number) ?? this.angle;
    this.penumbra = (source.penumbra as number) ?? this.penumbra;
    this.castShadow = (source.castShadow as boolean) ?? this.castShadow;
  }
}
