// ---------------------------------------------------------------------------
// 导航域：导航区域卡（NavAreaSection）与导航代理卡（NavAgentSection）的字段编辑。
//
// 协作与地形域一致：只依赖 useInspectorNode 的 ctx（node / commit），编辑走
// commit → mutateNode（整节点快照进撤销历史），写值统一经 parse 收敛。
// 烘焙按钮与寻路动作不走撤销（运行态操作），由卡片直连引擎 nav 系统。
// ---------------------------------------------------------------------------
import { NavAreaNode, NavAgentNode } from "../../../framework/prototype/derived/Primitives";
import {
  parseNavAgentSettings,
  parseNavAreaSettings,
  type NavAgentSettings,
  type NavAreaSettings,
} from "../../../framework/navigation";
import type { InspectorNodeApi } from "./useInspectorNode";

/** 区域卡事件标签 → 设置字段（标签即撤销历史文案） */
const AREA_LABEL_FIELD: Record<string, keyof NavAreaSettings> = {
  "Set Cell Size": "cellSize",
  "Set Agent Radius": "agentRadius",
  "Set Max Slope": "maxSlope",
  "Set Max Height Step": "maxHeightStep",
  "Set Nav Sources": "sourceIds",
  "Set Obstacles Mode": "obstaclesMode",
  "Set Display Mode": "display",
};

/** 代理卡事件标签 → 设置字段 */
const AGENT_LABEL_FIELD: Record<string, keyof NavAgentSettings> = {
  "Bind Nav Area": "areaId",
  "Set Agent Targets": "targetIds",
  "Set Agent Move Mode": "moveMode",
  "Toggle Agent Loop": "loop",
  "Set Speed": "speed",
  "Set Agent Size": "radius",
};

export interface InspectorNavApi {
  onNavAreaUpdate: (label: string, value: unknown) => void;
  onNavAgentUpdate: (label: string, value: unknown) => void;
}

export function useInspectorNav(ctx: InspectorNodeApi): InspectorNavApi {
  const { node, commit } = ctx;

  function onNavAreaUpdate(label: string, value: unknown): void {
    const n = node.value;
    if (!n || !(n instanceof NavAreaNode)) return;
    const field = AREA_LABEL_FIELD[label];
    if (!field) return;
    commit((m) => {
      const t = m as NavAreaNode;
      t.settings = parseNavAreaSettings({ ...t.settings, [field]: value });
    }, label);
  }

  function onNavAgentUpdate(label: string, value: unknown): void {
    const n = node.value;
    if (!n || !(n instanceof NavAgentNode)) return;
    const field = AGENT_LABEL_FIELD[label];
    if (!field) return;
    commit((m) => {
      const t = m as NavAgentNode;
      t.settings = parseNavAgentSettings({ ...t.settings, [field]: value });
    }, label);
  }

  return { onNavAreaUpdate, onNavAgentUpdate };
}
