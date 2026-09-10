import { cloneRecord } from "../types";
import { LightNode, type LightNodeInit, type ILightNode } from "./LightNode";
import {
  cloneLightShadow,
  parseLightShadow,
  type LightShadowConfig,
} from "../../lighting/shadow";

/** 点光源能力接口：有效距离 + 物理衰减指数 + 投射阴影 */
export interface IPointLightNode extends ILightNode {
  /** 光照有效距离（0 = 无限远，不衰减到零） */
  distance: number;
  /** 物理衰减指数 */
  decay: number;
  /** 投射阴影（立方体阴影贴图，六个面各一张） */
  castShadow: boolean;
  /** 阴影参数（浓度/偏移/近裁剪面，Unity Shadows 语义） */
  shadow: LightShadowConfig;
}

/** 点光源节点：全方位点光源，可配置有效距离、衰减指数与投射阴影。 */
export class PointLightNode extends LightNode implements IPointLightNode {
  static override readonly kType: string = "pointLightNode";
  override readonly typeKey: string = PointLightNode.kType;
  readonly lightKind = "point" as const;

  /** 光照有效距离（0 = 无限远，不衰减到零） */
  distance = 0;
  /** 物理衰减指数 */
  decay = 2;
  /** 投射阴影（默认关：立方阴影贴图渲染 6 个面，开销高于平面阴影） */
  castShadow = false;
  /** 阴影参数（Unity Shadows 语义：浓度/深度偏移/法线偏移/近裁剪面） */
  shadow: LightShadowConfig = parseLightShadow(undefined);

  constructor(
    init: LightNodeInit & {
      distance?: number;
      decay?: number;
      castShadow?: boolean;
      shadow?: LightShadowConfig;
    } = {},
  ) {
    super(init);
    this.distance = init.distance ?? this.distance;
    this.decay = init.decay ?? this.decay;
    this.castShadow = init.castShadow ?? this.castShadow;
    this.shadow = init.shadow ? cloneLightShadow(parseLightShadow(init.shadow)) : this.shadow;
  }

  override clone(): PointLightNode {
    const node = new PointLightNode({
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
    node.castShadow = this.castShadow;
    node.shadow = cloneLightShadow(this.shadow);
    return node;
  }

  protected override writeOwnData(target: Record<string, unknown>): void {
    this.writeCommon(target);
    target.distance = this.distance;
    target.decay = this.decay;
    target.castShadow = this.castShadow;
    target.shadow = cloneLightShadow(this.shadow);
  }

  protected override readOwnData(source: Record<string, unknown>): void {
    this.readCommon(source);
    this.distance = (source.distance as number) ?? this.distance;
    this.decay = (source.decay as number) ?? this.decay;
    this.castShadow = (source.castShadow as boolean) ?? this.castShadow;
    this.shadow = parseLightShadow(source.shadow);
  }
}
