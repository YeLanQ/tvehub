// ---------------------------------------------------------------------------
// 雾域：雾节点卡（FogSection）的字段编辑。
//
// 协作：只依赖 useInspectorNode 返回的 ctx（node / commit），域之间互不引用。
// 编辑走 commit → mutateNode（整节点快照进撤销历史），标签文案即历史文案。
// 写入统一经 parseFogSettings 收敛（取值域单一事实源在 framework/fog 的
// FOG_LIMITS；界面钳制只是预防，越界最终由 parse 兜底）。
// ---------------------------------------------------------------------------
import { FogNode } from "../../../framework/prototype/derived/Primitives";
import {
  parseFogSettings,
  type FogSettings,
} from "../../../framework/fog/types";
import type { InspectorNodeApi } from "./useInspectorNode";

/** 卡片事件标签 → 设置字段（标签即撤销历史文案） */
const LABEL_FIELD: Record<string, keyof FogSettings> = {
  "Set Fog Color": "color",
  "Set Fog Near": "near",
  "Set Fog Far": "far",
  "Set Fog Density": "density",
  "Set Fog Height": "heightY",
  "Set Fog Falloff": "heightFalloff",
};

export interface InspectorFogApi {
  onFogUpdate: (label: string, value: unknown) => void;
}

export function useInspectorFog(ctx: InspectorNodeApi): InspectorFogApi {
  const { node, commit } = ctx;

  function onFogUpdate(label: string, value: unknown): void {
    const n = node.value;
    if (!n || !(n instanceof FogNode)) return;
    const field = LABEL_FIELD[label];
    if (!field) return;
    commit((m) => {
      const f = m as FogNode;
      // 整体重新收敛：非法/越界值回到取值域内（与 parse 同一边界）
      f.fog = parseFogSettings({ ...f.fog, [field]: value });
    }, label);
  }

  return { onFogUpdate };
}
