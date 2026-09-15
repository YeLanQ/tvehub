import { Node, type NodeInit } from "../Node";
import { cloneRecord } from "../types";
import {
  DEFAULT_BT_RUNNER_SETTINGS,
  cloneLogicRunnerSettings,
  parseLogicRunnerSettings,
  type LogicRunnerSettings,
} from "../../logic/types";

export interface BtRunnerNodeInit extends NodeInit {
  /** 运行器设置（资产绑定/autoStart/时间倍率；随场景序列化） */
  settings?: LogicRunnerSettings;
}

/**
 * 行为树运行器节点：把 .bt 行为树资产绑到场景里跑（层级「逻辑」分组）。
 * - 数据只持设置（绑定资产 + 是否自动运行 + 时间倍率）；黑板/运行记忆是
 *   运行态，不序列化——求值与绑定由逻辑系统（framework/logic）承担，编辑器
 *   渲染循环推进，播放器侧 runtime/runtime/logic.ts 复用同一求值器；
 * - 动作叶子未注册处理器时按成功处理（脚本经 engine.logic.onAction 注册）。
 */
export class BtRunnerNode extends Node {
  static override readonly kType: string = "btRunnerNode";
  override readonly typeKey: string = BtRunnerNode.kType;

  settings: LogicRunnerSettings = { ...DEFAULT_BT_RUNNER_SETTINGS };

  constructor(init: BtRunnerNodeInit = {}) {
    super(init);
    this.settings = init.settings
      ? cloneLogicRunnerSettings(init.settings)
      : this.settings;
  }

  override clone(): BtRunnerNode {
    return new BtRunnerNode({
      name: this.name,
      transform: this.transform,
      properties: cloneRecord(this.properties),
      tag: this.tag,
      layer: this.layer,
      prefab: this.prefab,
      components: this.components,
      settings: cloneLogicRunnerSettings(this.settings),
    });
  }

  protected override writeOwnData(target: Record<string, unknown>): void {
    target.settings = cloneLogicRunnerSettings(this.settings);
  }

  protected override readOwnData(source: Record<string, unknown>): void {
    this.settings = parseLogicRunnerSettings(source.settings, ".bt");
  }
}
