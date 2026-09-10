import { Node, type NodeInit } from "../Node";
import type { INode } from "../interfaces";
import { cloneRecord } from "../types";
import {
  DEFAULT_PARTICLE_SETTINGS,
  cloneParticleSystemSettings,
  parseParticleSystemSettings,
  type ParticleSystemSettings,
} from "../../particles/types";

export interface ParticleSystemNodeInit extends NodeInit {
  /** 粒子发射设置（Main/Emission/Shape/Over Lifetime/Renderer 子集） */
  particles?: ParticleSystemSettings;
}

/** 粒子系统节点能力接口：发射设置（随场景序列化） */
export interface IParticleSystemNode extends INode {
  particles: ParticleSystemSettings;
}

/**
 * 粒子系统节点：场景中的粒子发射器（常规粒子系统语义子集）。
 * - 数据只持有发射设置；粒子本身为运行时状态，由 ParticleSystem（编辑器）/
 *   particles.mjs（播放器）按设置模拟并以 Points 渲染在节点对象下；
 * - 发射方向语义与灯光/相机一致：cone / box 沿节点本地 -Z；
 * - 播放/暂停/重启为运行时控制（不落盘），脚本经 SDK ParticleSystemNode 控制。
 */
export class ParticleSystemNode extends Node implements IParticleSystemNode {
  static override readonly kType: string = "particleSystemNode";
  override readonly typeKey: string = ParticleSystemNode.kType;

  /** 粒子发射设置（缺字段经 parse 回退默认，旧场景兼容） */
  particles: ParticleSystemSettings = { ...DEFAULT_PARTICLE_SETTINGS };

  constructor(init: ParticleSystemNodeInit = {}) {
    super(init);
    this.particles = init.particles ? cloneParticleSystemSettings(init.particles) : this.particles;
  }

  override clone(): ParticleSystemNode {
    return new ParticleSystemNode({
      name: this.name,
      transform: this.transform,
      properties: cloneRecord(this.properties),
      tag: this.tag,
      layer: this.layer,
      prefab: this.prefab,
      components: this.components,
      particles: cloneParticleSystemSettings(this.particles),
    });
  }

  protected override writeOwnData(target: Record<string, unknown>): void {
    target.particles = cloneParticleSystemSettings(this.particles);
  }

  protected override readOwnData(source: Record<string, unknown>): void {
    this.particles = parseParticleSystemSettings(source.particles);
  }
}
