import { Node, type NodeInit } from "../Node";
import type { INode } from "../interfaces";
import { cloneRecord } from "../types";
import {
  DEFAULT_TERRAIN_SETTINGS,
  cloneTerrainSettings,
  parseTerrainSettings,
  type TerrainSettings,
} from "../../terrain/types";

export interface TerrainNodeInit extends NodeInit {
  /** 程序化地形设置（高度场 + 表面配色；随场景序列化） */
  terrain?: TerrainSettings;
  /** 地形资产引用（.terrain 相对路径；空串 = 未绑定，仅作来源记录与回读） */
  asset?: string;
}

/** 地形节点能力接口：地形设置（随场景序列化） */
export interface ITerrainNode extends INode {
  terrain: TerrainSettings;
  asset: string;
}

/**
 * 地形节点：场景中的程序化高度场地形。
 * - 数据只持有设置；几何（位置/顶点色/索引）由设置烘焙（framework/terrain/generate.ts，
 *   播放器侧同语义 runtime/terrain.mjs），参数变化即重建；
 * - 表面配色按海拔/坡度烘焙为顶点色（草/林/岩/碎石/雪带），WebGL/WebGPU 通用；
 * - asset 为可选的 .terrain 资产引用：从资产创建时快照其设置到节点，
 *   检查器可回读/回存（运行时不读资产文件，设置始终内嵌在节点上）。
 */
export class TerrainNode extends Node implements ITerrainNode {
  static override readonly kType: string = "terrainNode";
  override readonly typeKey: string = TerrainNode.kType;

  terrain: TerrainSettings = { ...DEFAULT_TERRAIN_SETTINGS };
  asset = "";

  constructor(init: TerrainNodeInit = {}) {
    super(init);
    this.terrain = init.terrain ? cloneTerrainSettings(init.terrain) : this.terrain;
    this.asset = init.asset ?? "";
  }

  override clone(): TerrainNode {
    return new TerrainNode({
      name: this.name,
      transform: this.transform,
      properties: cloneRecord(this.properties),
      tag: this.tag,
      layer: this.layer,
      prefab: this.prefab,
      components: this.components,
      terrain: cloneTerrainSettings(this.terrain),
      asset: this.asset,
    });
  }

  protected override writeOwnData(target: Record<string, unknown>): void {
    target.terrain = cloneTerrainSettings(this.terrain);
    // 资产引用非空才写入（旧场景文件保持字节兼容）
    if (this.asset) target.asset = this.asset;
  }

  protected override readOwnData(source: Record<string, unknown>): void {
    this.terrain = parseTerrainSettings(source.terrain);
    this.asset = typeof source.asset === "string" ? source.asset : "";
  }
}

