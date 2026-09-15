import { Node, type NodeInit } from "../Node";
import { cloneRecord } from "../types";
import {
  DEFAULT_NAV_AGENT_SETTINGS,
  cloneNavAgentSettings,
  parseNavAgentSettings,
  type NavAgentSettings,
} from "../../navigation/types";

export interface NavAgentNodeInit extends NodeInit {
  /** 导航代理设置（移动速度/半径/区域绑定；随场景序列化） */
  settings?: NavAgentSettings;
}

/**
 * 导航代理节点：沿导航区域移动的角色载体（层级「导航」分组）。
 * - 数据只持设置（速度/半径/区域绑定）；路径与行进状态是运行态，不序列化——
 *   寻路经导航系统 requestPath，每帧沿路径推进并用烘焙 SDF 查表滑移避障；
 * - 移动回写只写渲染对象位姿（贴烘焙高度场），不写节点数据（与物理体同约定）。
 */
export class NavAgentNode extends Node {
  static override readonly kType: string = "navAgentNode";
  override readonly typeKey: string = NavAgentNode.kType;

  settings: NavAgentSettings = { ...DEFAULT_NAV_AGENT_SETTINGS, targetIds: [] };

  constructor(init: NavAgentNodeInit = {}) {
    super(init);
    this.settings = init.settings ? cloneNavAgentSettings(init.settings) : this.settings;
  }

  override clone(): NavAgentNode {
    return new NavAgentNode({
      name: this.name,
      transform: this.transform,
      properties: cloneRecord(this.properties),
      tag: this.tag,
      layer: this.layer,
      prefab: this.prefab,
      components: this.components,
      settings: cloneNavAgentSettings(this.settings),
    });
  }

  protected override writeOwnData(target: Record<string, unknown>): void {
    target.settings = cloneNavAgentSettings(this.settings);
  }

  protected override readOwnData(source: Record<string, unknown>): void {
    this.settings = parseNavAgentSettings(source.settings);
  }
}
