// ---------------------------------------------------------------------------
// 逻辑运行器设置（framework 层，不依赖 app/api 与 three）。
//
// 状态机/行为树需要"落到场景里跑"，载体是两个运行器节点（fsmRunnerNode /
// btRunnerNode）：节点只持设置（绑定哪个逻辑资产 + 是否自动运行 + 时间倍率），
// 求值状态（当前状态/黑板/运行记忆）是运行态，不序列化——与导航代理的路径、
// 物理体的速度同约定。读取经 parseLogicRunnerSettings 统一收敛，编辑器与
// 运行时共用同一形状。
// ---------------------------------------------------------------------------

/** 运行器设置取值域（检查器输入钳制用） */
export const LOGIC_RUNNER_LIMITS = {
  /** 时间倍率：0 = 暂停语义交给 autoStart/running，钳到正数 */
  speed: { min: 0.05, max: 20, step: 0.1 },
} as const;

/** 运行器节点设置（fsmRunnerNode / btRunnerNode 共用形状） */
export interface LogicRunnerSettings {
  /** 绑定的逻辑资产相对路径（.fsm / .bt；空 = 未绑定，运行器空转） */
  asset: string;
  /** 绑定就绪后自动开始运行（检查器可随时暂停/继续） */
  autoStart: boolean;
  /** 求值时间倍率（dt 缩放；影响 duration/等待/超时类计时） */
  speed: number;
}

export const DEFAULT_FSM_RUNNER_SETTINGS: LogicRunnerSettings = {
  asset: "",
  autoStart: true,
  speed: 1,
};

export const DEFAULT_BT_RUNNER_SETTINGS: LogicRunnerSettings = {
  asset: "",
  autoStart: true,
  speed: 1,
};

function str(v: unknown, fb = ""): string {
  return typeof v === "string" ? v : fb;
}

function num(v: unknown, fb: number, lo: number, hi: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fb;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * 任意来源 → 收敛的运行器设置：asset 按扩展名校验（不符清空 = 未绑定）、
 * speed 钳进取值域、autoStart 布尔收敛。
 */
export function parseLogicRunnerSettings(v: unknown, ext: ".fsm" | ".bt"): LogicRunnerSettings {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  let asset = str(o.asset);
  if (!asset.toLowerCase().endsWith(ext)) asset = "";
  return {
    asset,
    autoStart: typeof o.autoStart === "boolean" ? o.autoStart : true,
    speed: num(o.speed, 1, LOGIC_RUNNER_LIMITS.speed.min, LOGIC_RUNNER_LIMITS.speed.max),
  };
}

export function cloneLogicRunnerSettings(s: LogicRunnerSettings): LogicRunnerSettings {
  return { ...s };
}

/** 设置内容签名（绑定变化/参数调整时触发运行器重建；不含运行态） */
export function logicRunnerSettingsSig(s: LogicRunnerSettings): string {
  return `${s.asset}|${s.autoStart ? 1 : 0}|${s.speed.toFixed(3)}`;
}

/**
 * 逻辑资产文本 → 求值载荷（编辑器与运行时共用）：
 * 资产文件是信封形状（.fsm 取 graph 字段 / .bt 取 tree 字段，见
 * scene/logic_assets.rs 的序列化），直接是图/树形状时原样返回（容忍裸图）。
 */
export function unwrapLogicAsset(doc: unknown, kind: "fsm" | "bt"): unknown {
  if (doc && typeof doc === "object") {
    const inner = (doc as Record<string, unknown>)[kind === "fsm" ? "graph" : "tree"];
    if (inner && typeof inner === "object") return inner;
  }
  return doc;
}
