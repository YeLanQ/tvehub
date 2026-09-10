import { cloneRecord } from "../types";
import { LightNode, type LightNodeInit, type ILightNode } from "./LightNode";
import {
  cloneLightShadow,
  parseLightShadow,
  type LightShadowConfig,
} from "../../lighting/shadow";

/** 平行光能力接口：阴影开关 + 阴影参数 */
export interface IDirectionalLightNode extends ILightNode {
  castShadow: boolean;
  /** 阴影参数（浓度/偏移/近裁剪面，Unity Shadows 语义） */
  shadow: LightShadowConfig;
}

/** 平行光节点：平行光线沿节点本地 -Z 方向，可开启阴影。 */
export class DirectionalLightNode extends LightNode implements IDirectionalLightNode {
  static override readonly kType: string = "directionalLightNode";
  override readonly typeKey: string = DirectionalLightNode.kType;
  readonly lightKind = "directional" as const;

  castShadow = false;
  /** 阴影参数（Unity Shadows 语义：浓度/深度偏移/法线偏移/近裁剪面） */
  shadow: LightShadowConfig = parseLightShadow(undefined);

  constructor(init: LightNodeInit & { castShadow?: boolean; shadow?: LightShadowConfig } = {}) {
    super(init);
    this.castShadow = init.castShadow ?? this.castShadow;
    this.shadow = init.shadow ? cloneLightShadow(parseLightShadow(init.shadow)) : this.shadow;
  }

  override clone(): DirectionalLightNode {
    const node = new DirectionalLightNode({
      name: this.name,
      transform: this.transform,
      properties: cloneRecord(this.properties),
      tag: this.tag,
      layer: this.layer,
      prefab: this.prefab,
      components: this.components,
      intensity: this.intensity,
      cullingMask: this.cullingMask,
      lightColor: this.lightColor,
    });
    node.castShadow = this.castShadow;
    node.shadow = cloneLightShadow(this.shadow);
    return node;
  }

  protected override writeOwnData(target: Record<string, unknown>): void {
    this.writeCommon(target);
    target.castShadow = this.castShadow;
    target.shadow = cloneLightShadow(this.shadow);
  }

  protected override readOwnData(source: Record<string, unknown>): void {
    this.readCommon(source);
    this.castShadow = (source.castShadow as boolean) ?? this.castShadow;
    this.shadow = parseLightShadow(source.shadow);
  }
}
