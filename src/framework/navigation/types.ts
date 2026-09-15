// ---------------------------------------------------------------------------
// 导航数据类型（framework 层，不依赖 app/api）。
//
// 导航区域节点（NavAreaNode）持有可 JSON 序列化的烘焙设置：网格分辨率、代理
// 半径、最大坡度等。读取经 parseNavAreaSettings 统一收敛（缺失/越界回退默认，
// 旧场景兼容）。烘焙产物（可行走网格 + SDF 距离场）是运行时数据，不进场景
// JSON（与地形高度场同约定）：按 "userData + 签名 + 内存缓存" 处理，场景重开
// 时重烘焙。设置变化经签名判定是否需要重烘焙。
// ---------------------------------------------------------------------------

/** 调试可视化模式：关闭 / 可行走叠加 / SDF 距离场热力图 */
export type NavDisplayMode = "off" | "walkable" | "sdf";

/** 导航区域设置（NavAreaNode.settings 的形状；全部字段随场景序列化） */
export interface NavAreaSettings {
  /** 网格分辨率：一格边长（世界单位；越小越精细也越重） */
  cellSize: number;
  /** 代理半径（世界单位）：可行走判定要求到最近障碍的距离 ≥ 此值 */
  agentRadius: number;
  /** 最大可行走坡度（度，水平面为 0） */
  maxSlope: number;
  /** 相邻格最大高差（世界单位；跨不过去的坎/崖判定为不可行走） */
  maxHeightStep: number;
  /**
   * 采样源节点 id（地形或网格；空 = 自动使用场景中第一块地形）。
   * 多源按 2.5D 合并：每格取所有源的最高表面（不支持悬挑下层）。
   */
  sourceIds: string[];
  /** 障碍收集：auto = 收集场景静态碰撞体投影；ignore = 仅按地形坡度烘焙 */
  obstaclesMode: "auto" | "ignore";
  /** 调试可视化模式（SDF 热力图 = 烘焙距离场渲染） */
  display: NavDisplayMode;
}

export const DEFAULT_NAV_AREA_SETTINGS: NavAreaSettings = {
  cellSize: 1,
  agentRadius: 0.5,
  maxSlope: 45,
  maxHeightStep: 1.5,
  sourceIds: [],
  obstaclesMode: "auto",
  display: "walkable",
};

/** 导航区域数值取值域（检查器钳制 / parse 收敛共用） */
export const NAV_AREA_LIMITS = {
  cellSize: { min: 0.25, max: 10 },
  agentRadius: { min: 0, max: 10 },
  maxSlope: { min: 1, max: 89 },
  maxHeightStep: { min: 0.05, max: 50 },
} as const;

/** 导航代理设置（NavAgentNode.settings 的形状；全部字段随场景序列化） */
export interface NavAgentSettings {
  /** 绑定的导航区域节点 id（空 = 自动使用场景中第一个导航区域） */
  areaId: string;
  /** 移动速度（世界单位/秒） */
  speed: number;
  /** 碰撞半径（世界单位；沿路径移动时经 SDF 滑移避障） */
  radius: number;
}

export const DEFAULT_NAV_AGENT_SETTINGS: NavAgentSettings = {
  areaId: "",
  speed: 4,
  radius: 0.5,
};

export const NAV_AGENT_LIMITS = {
  speed: { min: 0.1, max: 100 },
  radius: { min: 0, max: 10 },
} as const;

const NAV_DISPLAY_MODES: NavDisplayMode[] = ["off", "walkable", "sdf"];

function clampNum(v: unknown, lo: number, hi: number, fb: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fb;
  return Math.min(hi, Math.max(lo, n));
}

function clampStr(v: unknown, fb = ""): string {
  return typeof v === "string" ? v : fb;
}

/** 采样源数量上限（防误粘贴超长数组；超过截断） */
const NAV_MAX_SOURCE_IDS = 32;

function clampSourceIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string" || !item) continue;
    if (!out.includes(item)) out.push(item);
    if (out.length >= NAV_MAX_SOURCE_IDS) break;
  }
  return out;
}

/** 任意来源 → 收敛的导航区域设置（旧场景 terrainId 迁移为单元素 sourceIds） */
export function parseNavAreaSettings(v: unknown): NavAreaSettings {
  const d = DEFAULT_NAV_AREA_SETTINGS;
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const L = NAV_AREA_LIMITS;
  const sourceIds = clampSourceIds(o.sourceIds);
  // 旧版场景（采样源仅支持地形）：terrainId → sourceIds
  if (sourceIds.length === 0 && typeof o.terrainId === "string" && o.terrainId) {
    sourceIds.push(o.terrainId);
  }
  return {
    cellSize: clampNum(o.cellSize, L.cellSize.min, L.cellSize.max, d.cellSize),
    agentRadius: clampNum(o.agentRadius, L.agentRadius.min, L.agentRadius.max, d.agentRadius),
    maxSlope: clampNum(o.maxSlope, L.maxSlope.min, L.maxSlope.max, d.maxSlope),
    maxHeightStep: clampNum(o.maxHeightStep, L.maxHeightStep.min, L.maxHeightStep.max, d.maxHeightStep),
    sourceIds,
    obstaclesMode: o.obstaclesMode === "ignore" ? "ignore" : "auto",
    display: NAV_DISPLAY_MODES.includes(o.display as NavDisplayMode) ? (o.display as NavDisplayMode) : d.display,
  };
}

/** 任意来源 → 收敛的导航代理设置 */
export function parseNavAgentSettings(v: unknown): NavAgentSettings {
  const d = DEFAULT_NAV_AGENT_SETTINGS;
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const L = NAV_AGENT_LIMITS;
  return {
    areaId: clampStr(o.areaId),
    speed: clampNum(o.speed, L.speed.min, L.speed.max, d.speed),
    radius: clampNum(o.radius, L.radius.min, L.radius.max, d.radius),
  };
}

export function cloneNavAreaSettings(v: NavAreaSettings): NavAreaSettings {
  return { ...v, sourceIds: [...v.sourceIds] };
}

export function cloneNavAgentSettings(v: NavAgentSettings): NavAgentSettings {
  return { ...v };
}

/**
 * 导航区域重烘焙签名（设置 → 字符串）：设置变化 → 烘焙数据失效。
 * 地形内容签名与障碍数量由调用方（NavSystem）拼接，一并在签名里体现。
 */
export function navAreaSettingsSig(s: NavAreaSettings): string {
  return [s.cellSize, s.agentRadius, s.maxSlope, s.maxHeightStep, s.sourceIds.join(","), s.obstaclesMode].join("|");
}

/** 导航代理绑定签名（区域绑定/半径变化 → 代理状态重置） */
export function navAgentSettingsSig(s: NavAgentSettings): string {
  return [s.areaId, s.speed, s.radius].join("|");
}
