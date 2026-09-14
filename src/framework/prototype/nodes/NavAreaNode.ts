import { Node, type NodeInit } from "../Node";
import { cloneRecord } from "../types";
import {
  DEFAULT_NAV_AREA_SETTINGS,
  cloneNavAreaSettings,
  parseNavAreaSettings,
  type NavAreaSettings,
} from "../../navigation/types";

export interface NavAreaNodeInit extends NodeInit {
  /** 导航烘焙设置（网格分辨率/代理半径/坡度上限等；随场景序列化） */
  settings?: NavAreaSettings;
}

/**
 * 导航区域节点：场景级导航烘焙载体（层级「导航」分组）。
 * - 数据只持设置；可行走网格 + SDF 距离场由设置 + 场景内容（地形高度场、静态
 *   碰撞体）烘焙（framework/navigation/NavSystem），不进场景 JSON——与地形
 *   高度场同约定：改设置即重烘焙，场景重开重烘焙；
 * - 覆盖范围自动取所采样地形（settings.terrainId，空 = 场景第一块地形）的范围，
 *   自身 Transform 不参与烘焙与显示（场景级节点，与雾/天空盒同语义）；
 * - 可视化叠层（可行走/SDF 热力图）由同步器按烘焙产物生成。
 */
export class NavAreaNode extends Node {
  static override readonly kType: string = "navAreaNode";
  override readonly typeKey: string = NavAreaNode.kType;

  settings: NavAreaSettings = { ...DEFAULT_NAV_AREA_SETTINGS };

  constructor(init: NavAreaNodeInit = {}) {
    super(init);
    this.settings = init.settings ? cloneNavAreaSettings(init.settings) : this.settings;
  }

  override clone(): NavAreaNode {
    return new NavAreaNode({
      name: this.name,
      transform: this.transform,
      properties: cloneRecord(this.properties),
      tag: this.tag,
      layer: this.layer,
      prefab: this.prefab,
      components: this.components,
      settings: cloneNavAreaSettings(this.settings),
    });
  }

  protected override writeOwnData(target: Record<string, unknown>): void {
    target.settings = cloneNavAreaSettings(this.settings);
  }

  protected override readOwnData(source: Record<string, unknown>): void {
    this.settings = parseNavAreaSettings(source.settings);
  }
}
