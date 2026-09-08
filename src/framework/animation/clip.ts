// ---------------------------------------------------------------------------
// 关键帧动画剪辑（framework 层纯数据 + 求值，不依赖 app/api/three）。
//
// .anim 资产 = AnimationClipData 的 JSON 文档：
// - 通道（curve.prop）：节点本地变换的 9 个分量（position.x/y/z、rotation.x/y/z
//   度制、scale.x/y/z），扩展新通道只需扩 PROP_CHANNELS；
// - 关键帧（key）：t 秒 + v 值 + 到下一关键帧的插值 i（linear/step/smooth）；
//   smooth = 三次 Hermite（Catmull-Rom 切线，支持非均匀时间）；
// - 求值在关键帧区间外钳制到端点值；曲线按 t 升序保持（操作函数负责排序）。
// ---------------------------------------------------------------------------

/** 变换通道名（9 个；rotation 为度） */
export type TransformProp =
  | "position.x" | "position.y" | "position.z"
  | "rotation.x" | "rotation.y" | "rotation.z"
  | "scale.x" | "scale.y" | "scale.z";

/** 关键帧插值：线性 / 阶跃（保持前值）/ 平滑（Catmull-Rom） */
export type AnimKeyInterp = "linear" | "step" | "smooth";

/** 单个关键帧：t 秒、v 值、i 为该帧到下一帧区间的插值方式 */
export interface AnimKey {
  t: number;
  v: number;
  i: AnimKeyInterp;
}

/** 单通道曲线：一条属性的关键帧序列（t 升序） */
export interface AnimClipCurve {
  prop: TransformProp;
  keys: AnimKey[];
}

/** 动画剪辑完整数据（.anim 资产文档形状） */
export interface AnimationClipData {
  /** 格式标识 */
  type: "animclip";
  /** 剪辑名（展示用） */
  name: string;
  /** 时长（秒，>0） */
  duration: number;
  /** 周期循环（false = 播一次停在末帧） */
  loops: boolean;
  curves: AnimClipCurve[];
}

export const PROP_CHANNELS: {
  prop: TransformProp;
  label: string;
  group: "位置" | "旋转" | "缩放";
}[] = [
  { prop: "position.x", label: "位置 X", group: "位置" },
  { prop: "position.y", label: "位置 Y", group: "位置" },
  { prop: "position.z", label: "位置 Z", group: "位置" },
  { prop: "rotation.x", label: "旋转 X", group: "旋转" },
  { prop: "rotation.y", label: "旋转 Y", group: "旋转" },
  { prop: "rotation.z", label: "旋转 Z", group: "旋转" },
  { prop: "scale.x", label: "缩放 X", group: "缩放" },
  { prop: "scale.y", label: "缩放 Y", group: "缩放" },
  { prop: "scale.z", label: "缩放 Z", group: "缩放" },
];

const INTERPS: AnimKeyInterp[] = ["linear", "step", "smooth"];

export const DEFAULT_CLIP_DURATION = 3;

function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 任意来源 → 收敛的关键帧（t/v 非法剔除，插值回退 linear） */
function parseKeys(v: unknown): AnimKey[] {
  if (!Array.isArray(v)) return [];
  const keys: AnimKey[] = [];
  for (const k of v) {
    if (!k || typeof k !== "object") continue;
    const ko = k as Record<string, unknown>;
    const t = num(ko.t, NaN);
    const val = num(ko.v, NaN);
    if (!Number.isFinite(t) || !Number.isFinite(val)) continue;
    keys.push({
      t,
      v: val,
      i: INTERPS.includes(ko.i as AnimKeyInterp) ? (ko.i as AnimKeyInterp) : "linear",
    });
  }
  keys.sort((a, b) => a.t - b.t);
  return keys;
}

/** 任意来源 → 收敛的动画剪辑（通道去重、时长钳制） */
export function parseAnimationClip(v: unknown): AnimationClipData {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const curves: AnimClipCurve[] = [];
  const seen = new Set<string>();
  const raw = Array.isArray(o.curves) ? o.curves : [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const co = c as Record<string, unknown>;
    const prop = co.prop;
    if (typeof prop !== "string" || seen.has(prop)) continue;
    if (!PROP_CHANNELS.some((p) => p.prop === prop)) continue;
    seen.add(prop);
    curves.push({ prop: prop as TransformProp, keys: parseKeys(co.keys) });
  }
  return {
    type: "animclip",
    name: typeof o.name === "string" && o.name ? o.name : "Animation Clip",
    duration: clamp(num(o.duration, DEFAULT_CLIP_DURATION), 0.1, 3600),
    loops: o.loops !== false,
    curves,
  };
}

/** 深拷贝剪辑（编辑工作副本） */
export function cloneAnimationClip(c: AnimationClipData): AnimationClipData {
  return JSON.parse(JSON.stringify(c)) as AnimationClipData;
}

/** 二分查找：最后一个 t <= time 的关键帧下标（-1 表示在首帧之前） */
function keyIndexBefore(keys: AnimKey[], t: number): number {
  let lo = 0;
  let hi = keys.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t <= t) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return idx;
}

/** Catmull-Rom 切线（非均匀时间；端点用单侧差分） */
function tangentOf(keys: AnimKey[], i: number): number {
  const prev = keys[i - 1];
  const cur = keys[i];
  const next = keys[i + 1];
  if (prev && next) return (next.v - prev.v) / Math.max(1e-6, next.t - prev.t);
  if (next) return (next.v - cur.v) / Math.max(1e-6, next.t - cur.t);
  if (prev) return (cur.v - prev.v) / Math.max(1e-6, cur.t - prev.t);
  return 0;
}

/** 采样单通道曲线（区间外钳端点；空曲线返回 null） */
export function evaluateCurve(curve: AnimClipCurve, time: number): number | null {
  const keys = curve.keys;
  if (!keys.length) return null;
  if (time <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (time >= last.t) return last.v;
  const i = keyIndexBefore(keys, time);
  const k1 = keys[i];
  const k2 = keys[i + 1];
  if (!k2) return k1.v;
  if (k1.i === "step") return k1.v;
  const span = Math.max(1e-6, k2.t - k1.t);
  const u = (time - k1.t) / span;
  if (k1.i === "smooth") {
    // 三次 Hermite：切线取 Catmull-Rom（相邻关键帧中心差分）
    const m1 = tangentOf(keys, i) * span;
    const m2 = tangentOf(keys, i + 1) * span;
    const u2 = u * u;
    const u3 = u2 * u;
    return (
      (2 * u3 - 3 * u2 + 1) * k1.v +
      (u3 - 2 * u2 + u) * m1 +
      (-2 * u3 + 3 * u2) * k2.v +
      (u3 - u2) * m2
    );
  }
  return k1.v + (k2.v - k1.v) * u;
}

/** 采样剪辑：time 超出时长时按 loops 取模回绕（once 钳制末值），返回通道 → 值 */
export function evaluateClip(
  clip: AnimationClipData,
  time: number,
): Map<TransformProp, number> {
  const out = new Map<TransformProp, number>();
  let t = time;
  if (clip.loops && clip.duration > 0) t = ((time % clip.duration) + clip.duration) % clip.duration;
  else t = clamp(time, 0, clip.duration);
  for (const c of clip.curves) {
    const v = evaluateCurve(c, t);
    if (v !== null) out.set(c.prop, v);
  }
  return out;
}

/** 写入/替换某时刻的关键帧（同帧 ±1e-4 内视为同一帧；保持 t 升序） */
export function upsertKey(curve: AnimClipCurve, t: number, v: number, interp: AnimKeyInterp = "linear"): void {
  const eps = 1e-4;
  const existing = curve.keys.find((k) => Math.abs(k.t - t) <= eps);
  if (existing) {
    existing.v = v;
    return;
  }
  curve.keys.push({ t, v, i: interp });
  curve.keys.sort((a, b) => a.t - b.t);
}

/** 删除某时刻附近的关键帧；返回是否删除 */
export function removeKeyAt(curve: AnimClipCurve, t: number): boolean {
  const eps = 1e-4;
  const i = curve.keys.findIndex((k) => Math.abs(k.t - t) <= eps);
  if (i < 0) return false;
  curve.keys.splice(i, 1);
  return true;
}

/** 生成不冲突的空剪辑文档（新建动画资产用） */
export function emptyClipDoc(name: string): AnimationClipData {
  return { type: "animclip", name, duration: DEFAULT_CLIP_DURATION, loops: true, curves: [] };
}
