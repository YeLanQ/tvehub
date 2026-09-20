// ---------------------------------------------------------------------------
// 装载蒙版进度口径（编辑器窗口与图窗口共用一份，避免两处各算各的）。
// store 只维护阶段状态，展示用的百分比由本模块统一折算。
// ---------------------------------------------------------------------------

/** 折算进度的最小阶段形状（图窗口的阶段没有逐项计量，done/total 缺省） */
export interface BootProgressStage {
  status: "pending" | "active" | "done" | "failed";
  /** 已完成条目数（仅带逐项计量的阶段有） */
  done?: number;
  /** 总条目数（0/缺省 = 该阶段无逐项计量） */
  total?: number;
}

/** 有计量阶段进行中的折算上限：走满也停在 95%，余下 5% 由 complete() 补上 */
const ACTIVE_COUNTED_MAX = 0.95;
/** 无计量阶段进行中的折算值 */
const ACTIVE_UNCOUNTED = 0.4;

/**
 * 各阶段折算进度（等权平均）：done/failed = 1，active 有计量按 n/N（上限 95%）、
 * 无计量按 0.4，pending = 0。返回 0..100 的整数。
 */
export function bootStagePercent(stages: readonly BootProgressStage[]): number {
  if (stages.length === 0) return 0;
  let sum = 0;
  for (const s of stages) {
    if (s.status === "done" || s.status === "failed") {
      sum += 1;
    } else if (s.status === "active") {
      const total = s.total ?? 0;
      sum += total > 0 ? Math.min(1, (s.done ?? 0) / total) * ACTIVE_COUNTED_MAX : ACTIVE_UNCOUNTED;
    }
  }
  return Math.round((sum / stages.length) * 100);
}
