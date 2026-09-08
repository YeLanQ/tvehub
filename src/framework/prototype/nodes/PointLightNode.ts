import { cloneRecord } from "../types";
import { LightNode, type LightNodeInit } from "./LightNode";

/** 点光源节点：全方位点光源，可配置有效距离与衰减指数。 */
export class PointLightNode extends LightNode {
  static override readonly kType: string = "pointLightNode";
  override readonly typeKey: string = PointLightNode.kType;
  readonly lightKind = "point" as const;

  /** 光照有效距离（0 = 无限远，不衰减到零） */
  distance = 0;
  /** 物理衰减指数 */
  decay = 2;

  constructor(init: LightNodeInit & { distance?: number; decay?: number } = {}) {
    super(init);
    this.distance = init.distance ?? this.distance;
    this.decay = init.decay ?? this.decay;
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
    return node;
  }

  protected override writeOwnData(target: Record<string, unknown>): void {
    this.writeCommon(target);
    target.distance = this.distance;
    target.decay = this.decay;
  }

  protected override readOwnData(source: Record<string, unknown>): void {
    this.readCommon(source);
    this.distance = (source.distance as number) ?? this.distance;
    this.decay = (source.decay as number) ?? this.decay;
  }
}
