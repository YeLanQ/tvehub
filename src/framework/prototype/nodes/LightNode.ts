import { Node, type NodeInit } from "../Node";

export type LightKind = "point" | "directional" | "ambient" | "spot";

export interface LightNodeInit extends NodeInit {
  intensity?: number;
  lightColor?: number;
}

/**
 * 灯光节点基类。
 *
 * 灯光按类型拆分为独立节点原型（PointLightNode / DirectionalLightNode /
 * AmbientLightNode / SpotLightNode），基类只维护所有灯光共有的参数：
 * 强度 intensity 与颜色 lightColor，并暴露类型标识 lightKind。
 * 具体类型各自的参数（距离、衰减、角度、阴影…）由子类扩展。
 */
export abstract class LightNode extends Node {
  static override readonly kType: string = "lightNode";
  override readonly typeKey: string = LightNode.kType;

  /** 灯光类型标识（由具体子类固定） */
  abstract readonly lightKind: LightKind;

  intensity = 1;
  lightColor = 0xffffff;

  constructor(init: LightNodeInit = {}) {
    super(init);
    this.intensity = init.intensity ?? this.intensity;
    this.lightColor = init.lightColor ?? this.lightColor;
  }

  /** 子类在 writeOwnData / readOwnData 里追加自身参数时，先落公共字段 */
  protected writeCommon(target: Record<string, unknown>): void {
    target.intensity = this.intensity;
    target.lightColor = this.lightColor;
  }

  protected readCommon(source: Record<string, unknown>): void {
    this.intensity = (source.intensity as number) ?? this.intensity;
    this.lightColor = (source.lightColor as number) ?? this.lightColor;
  }
}
