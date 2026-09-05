import { cloneRecord } from "../types";
import { LightNode, type LightNodeInit } from "./LightNode";

/** 环境光节点：无方向、无距离衰减，仅颜色 + 强度。 */
export class AmbientLightNode extends LightNode {
  static override readonly kType: string = "ambientLightNode";
  override readonly typeKey: string = AmbientLightNode.kType;
  readonly lightKind = "ambient" as const;

  constructor(init: LightNodeInit = {}) {
    super(init);
  }

  override clone(): AmbientLightNode {
    return new AmbientLightNode({
      name: this.name,
      transform: this.transform,
      properties: cloneRecord(this.properties),
      intensity: this.intensity,
      lightColor: this.lightColor,
    });
  }

  protected override writeOwnData(target: Record<string, unknown>): void {
    this.writeCommon(target);
  }

  protected override readOwnData(source: Record<string, unknown>): void {
    this.readCommon(source);
  }
}
