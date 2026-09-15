import { Node, type NodeInit } from "../Node";
import { cloneRecord } from "../types";
import {
  DEFAULT_FSM_RUNNER_SETTINGS,
  cloneLogicRunnerSettings,
  parseLogicRunnerSettings,
  type LogicRunnerSettings,
} from "../../logic/types";

export interface FsmRunnerNodeInit extends NodeInit {
  /** 运行器设置（资产绑定/autoStart/时间倍率；随场景序列化） */
  settings?: LogicRunnerSettings;
}

/**
 * 状态机运行器节点：把 .fsm 状态机资产绑到场景里跑（层级「逻辑」分组）。
 * - 数据只持设置（绑定资产 + 是否自动运行 + 时间倍率）；当前状态/参数黑板是
 *   运行态，不序列化——求值与绑定由逻辑系统（framework/logic）承担，编辑器
 *   渲染循环推进，播放器侧 runtime/runtime/logic.ts 复用同一求值器；
 * - 不写渲染对象位姿（状态机只产出状态与黑板，表现由脚本/动画经引擎 API 消费）。
 */
export class FsmRunnerNode extends Node {
  static override readonly kType: string = "fsmRunnerNode";
  override readonly typeKey: string = FsmRunnerNode.kType;

  settings: LogicRunnerSettings = { ...DEFAULT_FSM_RUNNER_SETTINGS };

  constructor(init: FsmRunnerNodeInit = {}) {
    super(init);
    this.settings = init.settings
      ? cloneLogicRunnerSettings(init.settings)
      : this.settings;
  }

  override clone(): FsmRunnerNode {
    return new FsmRunnerNode({
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
    this.settings = parseLogicRunnerSettings(source.settings, ".fsm");
  }
}
