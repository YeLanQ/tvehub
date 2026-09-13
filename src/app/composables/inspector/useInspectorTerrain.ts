// ---------------------------------------------------------------------------
// 地形域：地形节点卡（TerrainSection）的字段编辑。
//
// 协作：只依赖 useInspectorNode 返回的 ctx（node / commit），域之间互不引用。
// 编辑走 commit → mutateNode（整节点快照进撤销历史），标签文案即历史文案。
// 写入统一经 parseTerrainSettings 收敛（取值域单一事实源在 framework/terrain
// 的 TERRAIN_LIMITS；界面钳制只是预防，越界最终由 parse 兜底）。
// 资产动作（绑定/解绑/保存到 .terrain）由卡片直连文件读写，绑定经这里落节点。
// ---------------------------------------------------------------------------
import { TerrainNode } from "../../../framework/prototype/derived/Primitives";
import {
  parseTerrainSettings,
  type TerrainSettings,
} from "../../../framework/terrain";
import type { InspectorNodeApi } from "./useInspectorNode";

/** 卡片事件标签 → 设置字段（标签即撤销历史文案） */
const LABEL_FIELD: Record<string, keyof TerrainSettings> = {
  "Set Seed": "seed",
  "Set Size": "size",
  "Set Segments": "segments",
  "Set Height Scale": "heightScale",
  "Set Frequency": "frequency",
  "Set Octaves": "octaves",
  "Set Lacunarity": "lacunarity",
  "Set Gain": "gain",
  "Set Erosion": "erosion",
  "Set Warp": "warp",
  "Set Valley Bias": "valleyBias",
  "Set Sea Level": "seaLevel",
  "Set Talus": "talus",
  "Set Talus Passes": "talusPasses",
  "Set Grass Color": "grassColor",
  "Set Rock Color": "rockColor",
  "Set Snow Color": "snowColor",
};

export interface InspectorTerrainApi {
  onTerrainUpdate: (label: string, value: unknown) => void;
}

export function useInspectorTerrain(ctx: InspectorNodeApi): InspectorTerrainApi {
  const { node, commit } = ctx;

  function onTerrainUpdate(label: string, value: unknown): void {
    const n = node.value;
    if (!n || !(n instanceof TerrainNode)) return;
    // 绑定资产：记录引用 + 快照资产设置到节点（value = { rel, settings }）
    if (label === "Bind Terrain Asset") {
      const v = value as { rel: string; settings: unknown };
      const rel = String(v?.rel ?? "");
      commit((m) => {
        const t = m as TerrainNode;
        t.asset = rel;
        if (v?.settings) t.terrain = parseTerrainSettings(v.settings);
      }, rel ? `绑定地形资产: ${rel}` : "解绑地形资产");
      return;
    }
    const field = LABEL_FIELD[label];
    if (!field) return;
    commit((m) => {
      const t = m as TerrainNode;
      // 整体重新收敛：非法/越界值回到取值域内（与 parse 同一边界）
      t.terrain = parseTerrainSettings({ ...t.terrain, [field]: value });
    }, label);
  }

  return { onTerrainUpdate };
}
