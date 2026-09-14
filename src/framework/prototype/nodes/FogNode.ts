import { Node, type NodeInit } from "../Node";
import type { INode } from "../interfaces";
import { cloneRecord } from "../types";
import {
  DEFAULT_FOG_SETTINGS,
  cloneFogSettings,
  parseFogSettings,
  type FogKind,
  type FogSettings,
} from "../../fog/types";

export type { FogKind, FogSettings };

export interface FogNodeInit extends NodeInit {
  /** 雾类型（linear=线性雾 / exp2=指数雾；由创建菜单固定，不随序列化切换） */
  fogKind?: FogKind;
  /** 雾设置（颜色 + near/far/density；随场景序列化，按 fogKind 取用） */
  fog?: FogSettings;
}

/** 雾节点能力接口：类型 + 雾设置（随场景序列化） */
export interface IFogNode extends INode {
  fogKind: FogKind;
  fog: FogSettings;
}

/**
 * 雾节点：场景环境级节点（不属于实体网格，与天空盒同语义）。
 * 场景中第一个"启用且可见"的雾节点决定渲染雾（scene.fog）：
 * - linear（线性雾）：near→far 距离间线性过渡到雾色（THREE.Fog）；
 * - exp2（指数雾）：按相机距离指数衰减（THREE.FogExp2）；
 * - height（高度雾）：exp2 基础浓度 + 海拔衰减（谷浓山淡；着色器级注入，
 *   见 framework/fog/heightFog.ts，WebGL 走 fog chunk patch、WebGPU 走 TSL 雾节点）。
 * 类型在创建时由菜单固定（"新建 > 雾 > 雾类型"），检查器只调参数。
 */
export class FogNode extends Node implements IFogNode {
  static override readonly kType: string = "fogNode";
  override readonly typeKey: string = FogNode.kType;

  fogKind: FogKind = "linear";
  fog: FogSettings = { ...DEFAULT_FOG_SETTINGS };

  constructor(init: FogNodeInit = {}) {
    super(init);
    if (init.fogKind === "linear" || init.fogKind === "exp2" || init.fogKind === "height") {
      this.fogKind = init.fogKind;
    }
    this.fog = init.fog ? cloneFogSettings(init.fog) : this.fog;
  }

  override clone(): FogNode {
    return new FogNode({
      name: this.name,
      transform: this.transform,
      properties: cloneRecord(this.properties),
      tag: this.tag,
      layer: this.layer,
      prefab: this.prefab,
      components: this.components,
      fogKind: this.fogKind,
      fog: cloneFogSettings(this.fog),
    });
  }

  protected override writeOwnData(target: Record<string, unknown>): void {
    target.fogKind = this.fogKind;
    target.fog = cloneFogSettings(this.fog);
  }

  protected override readOwnData(source: Record<string, unknown>): void {
    const kind = source.fogKind as FogKind | undefined;
    if (kind === "linear" || kind === "exp2" || kind === "height") this.fogKind = kind;
    this.fog = parseFogSettings(source.fog);
  }
}
