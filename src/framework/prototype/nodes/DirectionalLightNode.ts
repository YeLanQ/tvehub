import { cloneRecord } from "../types";
import { LightNode, type LightNodeInit, type ILightNode } from "./LightNode";

/** 平行光能力接口：阴影开关 */
export interface IDirectionalLightNode extends ILightNode {
  castShadow: boolean;
}

/** 平行光节点：平行光线沿节点本地 -Z 方向，可开启阴影。 */
export class DirectionalLightNode extends LightNode implements IDirectionalLightNode {
  static override readonly kType: string = "directionalLightNode";
  override readonly typeKey: string = DirectionalLightNode.kType;
  readonly lightKind = "directional" as const;

  castShadow = false;

  constructor(init: LightNodeInit & { castShadow?: boolean } = {}) {
    super(init);
    this.castShadow = init.castShadow ?? this.castShadow;
  }

  override clone(): DirectionalLightNode {
    const node = new DirectionalLightNode({
      name: this.name,
      transform: this.transform,
      properties: cloneRecord(this.properties),
      tag: this.tag,
      prefab: this.prefab,
      components: this.components,
      intensity: this.intensity,
      lightColor: this.lightColor,
    });
    node.castShadow = this.castShadow;
    return node;
  }

  protected override writeOwnData(target: Record<string, unknown>): void {
    this.writeCommon(target);
    target.castShadow = this.castShadow;
  }

  protected override readOwnData(source: Record<string, unknown>): void {
    this.readCommon(source);
    this.castShadow = (source.castShadow as boolean) ?? this.castShadow;
  }
}
