import { Node, type NodeInit } from "../Node";
import { cloneRecord, vec3, type Vec3 } from "../types";

export interface LightNodeInit extends NodeInit {
  lightKind?: "point" | "directional" | "ambient";
  intensity?: number;
  lightColor?: number;
  positionHint?: Vec3;
  castShadow?: boolean;
}

export class LightNode extends Node {
  static override readonly kType: string = "lightNode";
  override readonly typeKey: string = LightNode.kType;
  lightKind: "point" | "directional" | "ambient" = "point";
  intensity = 1;
  lightColor = 0xffffff;
  positionHint: Vec3 = vec3(5, 5, 5);
  castShadow = false;

  constructor(init: LightNodeInit = {}) {
    super(init);
    this.lightKind = init.lightKind ?? this.lightKind;
    this.intensity = init.intensity ?? this.intensity;
    this.lightColor = init.lightColor ?? this.lightColor;
    if (init.positionHint) this.positionHint = { ...init.positionHint };
    this.castShadow = init.castShadow ?? this.castShadow;
  }

  override clone(): LightNode {
    return new LightNode({
      name: this.name,
      transform: this.transform,
      properties: cloneRecord(this.properties),
      lightKind: this.lightKind,
      intensity: this.intensity,
      lightColor: this.lightColor,
      positionHint: this.positionHint,
      castShadow: this.castShadow,
    });
  }

  protected override writeOwnData(target: Record<string, unknown>): void {
    target.lightKind = this.lightKind;
    target.intensity = this.intensity;
    target.lightColor = this.lightColor;
    target.positionHint = { ...this.positionHint };
    target.castShadow = this.castShadow;
  }

  protected override readOwnData(source: Record<string, unknown>): void {
    this.lightKind = (source.lightKind as LightNode["lightKind"]) ?? this.lightKind;
    this.intensity = (source.intensity as number) ?? this.intensity;
    this.lightColor = (source.lightColor as number) ?? this.lightColor;
    this.positionHint = (source.positionHint as Vec3) ?? this.positionHint;
    this.castShadow = (source.castShadow as boolean) ?? this.castShadow;
  }

  static fromJSON(json: Record<string, unknown>): LightNode {
    const node = new LightNode();
    node.applyJSON(json);
    return node;
  }
}