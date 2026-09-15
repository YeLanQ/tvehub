// ---------------------------------------------------------------------------
// 逻辑域：状态机运行器卡（FsmRunnerSection）与行为树运行器卡（BtRunnerSection）
// 的字段编辑。
//
// 协作与导航域一致：只依赖 useInspectorNode 的 ctx（node / commit），编辑走
// commit → mutateNode（整节点快照进撤销历史），写值统一经 parse 收敛。
// 运行控制（运行/暂停/重启/事件/参数黑板/强制切换）不走撤销（运行态操作），
// 由卡片直连引擎 logic 系统。
// ---------------------------------------------------------------------------
import { FsmRunnerNode, BtRunnerNode } from "../../../framework/prototype/derived/Primitives";
import { parseLogicRunnerSettings, type LogicRunnerSettings } from "../../../framework/logic";
import type { InspectorNodeApi } from "./useInspectorNode";

/** 状态机卡事件标签 → 设置字段（标签即撤销历史文案） */
const FSM_LABEL_FIELD: Record<string, keyof LogicRunnerSettings> = {
  "Bind FSM Asset": "asset",
  "Toggle FSM Auto Start": "autoStart",
  "Set FSM Speed": "speed",
};

/** 行为树卡事件标签 → 设置字段 */
const BT_LABEL_FIELD: Record<string, keyof LogicRunnerSettings> = {
  "Bind BT Asset": "asset",
  "Toggle BT Auto Start": "autoStart",
  "Set BT Speed": "speed",
};

export interface InspectorLogicApi {
  onFsmRunnerUpdate: (label: string, value: unknown) => void;
  onBtRunnerUpdate: (label: string, value: unknown) => void;
}

export function useInspectorLogic(ctx: InspectorNodeApi): InspectorLogicApi {
  const { node, commit } = ctx;

  function onFsmRunnerUpdate(label: string, value: unknown): void {
    const n = node.value;
    if (!n || !(n instanceof FsmRunnerNode)) return;
    const field = FSM_LABEL_FIELD[label];
    if (!field) return;
    commit((m) => {
      const t = m as FsmRunnerNode;
      t.settings = parseLogicRunnerSettings({ ...t.settings, [field]: value }, ".fsm");
    }, label);
  }

  function onBtRunnerUpdate(label: string, value: unknown): void {
    const n = node.value;
    if (!n || !(n instanceof BtRunnerNode)) return;
    const field = BT_LABEL_FIELD[label];
    if (!field) return;
    commit((m) => {
      const t = m as BtRunnerNode;
      t.settings = parseLogicRunnerSettings({ ...t.settings, [field]: value }, ".bt");
    }, label);
  }

  return { onFsmRunnerUpdate, onBtRunnerUpdate };
}
