// ---------------------------------------------------------------------------
// 关键帧动画剪辑（framework 层纯数据 + 求值，不依赖 app/api/three）。
//
// .anim 资产 = AnimationClipData 的 JSON 文档：
// - 通道（curve.prop）：任意可动画属性的字符串键（如 "position.x"、
//   "light.intensity"、"material.color.r"），分组约定 = 首段（变换 position/
//   rotation/scale 直接映射节点对象变换；其余组由播放器按目标解析应用——
//   材质 → 对象材质、灯光 → 对象子树内的灯光）。可动画通道目录见
//   app/lib/anim-props.ts（按节点能力提供）；
// - 关键帧（key）：t 秒 + v 值 + 到下一关键帧的插值 i（linear/step/smooth）；
//   smooth = 三次 Hermite，切线默认自动（Catmull-Rom 中心差分，支持非均匀时间），
//   可被手动贝塞尔切线覆盖：ti/to = 入/出切线斜率（dv/dt，缺省 = 自动）、
//   tm = true 时两侧联动（对称，拖一侧镜像另一侧；缺省 = 独立）；
// - 求值在关键帧区间外钳制到端点值；曲线按 t 升序保持（操作函数负责排序）。
// ---------------------------------------------------------------------------

/** 通道键（字符串；分组约定见文件头） */
export type AnimProp = string;

/** 关键帧插值：线性 / 阶跃（保持前值）/ 平滑（Hermite，切线自动或手动） */
export type AnimKeyInterp = "linear" | "step" | "smooth";

/** 手动切线斜率的钳制上限（dv/dt；超过按上限收敛） */
export const TANGENT_CLAMP = 10000;

/** 单个关键帧：t 秒、v 值、i 为该帧到下一帧区间的插值方式；
 *  ti/to 为手动入/出切线斜率（undefined = 自动 Catmull-Rom）、tm 两侧联动 */
export interface AnimKey {
  t: number;
  v: number;
  i: AnimKeyInterp;
  ti?: number;
  to?: number;
  tm?: boolean;
}

/** 单通道曲线：一条属性的关键帧序列（t 升序） */
export interface AnimClipCurve {
  prop: AnimProp;
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

const INTERPS: AnimKeyInterp[] = ["linear", "step", "smooth"];

export const DEFAULT_CLIP_DURATION = 3;

function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 任意来源 → 收敛的关键帧（t/v 非法剔除，插值回退 linear，切线钳制/非法剔除） */
function parseKeys(v: unknown): AnimKey[] {
  if (!Array.isArray(v)) return [];
  const keys: AnimKey[] = [];
  for (const k of v) {
    if (!k || typeof k !== "object") continue;
    const ko = k as Record<string, unknown>;
    const t = num(ko.t, NaN);
    const val = num(ko.v, NaN);
    if (!Number.isFinite(t) || !Number.isFinite(val)) continue;
    const key: AnimKey = {
      t,
      v: val,
      i: INTERPS.includes(ko.i as AnimKeyInterp) ? (ko.i as AnimKeyInterp) : "linear",
    };
    const ti = num(ko.ti, NaN);
    if (Number.isFinite(ti)) key.ti = clamp(ti, -TANGENT_CLAMP, TANGENT_CLAMP);
    const to = num(ko.to, NaN);
    if (Number.isFinite(to)) key.to = clamp(to, -TANGENT_CLAMP, TANGENT_CLAMP);
    if (ko.tm === true) key.tm = true;
    keys.push(key);
  }
  keys.sort((a, b) => a.t - b.t);
  return keys;
}

/** 任意来源 → 收敛的动画剪辑（通道去重、时长钳制；prop 为任意非空字符串） */
export function parseAnimationClip(v: unknown): AnimationClipData {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const curves: AnimClipCurve[] = [];
  const seen = new Set<string>();
  const raw = Array.isArray(o.curves) ? o.curves : [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const co = c as Record<string, unknown>;
    const prop = co.prop;
    if (typeof prop !== "string" || !prop || seen.has(prop)) continue;
    seen.add(prop);
    curves.push({ prop, keys: parseKeys(co.keys) });
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

/** 关键帧某侧生效切线斜率（dv/dt）：手动 ti/to 优先，否则自动 Catmull-Rom */
export function keySlope(keys: AnimKey[], i: number, side: "ti" | "to"): number {
  const manual = side === "ti" ? keys[i]?.ti : keys[i]?.to;
  return manual ?? tangentOf(keys, i);
}

/** 该帧两侧切线是否处于自动态（无任一手动斜率） */
export function isAutoTangent(k: AnimKey): boolean {
  return k.ti === undefined && k.to === undefined;
}

/** 固化自动切线为手动值（拖手柄/拖帧前调用，保持曲线形状不跳变） */
export function ensureManualTangents(keys: AnimKey[], i: number): void {
  const k = keys[i];
  if (!k || !isAutoTangent(k)) return;
  k.ti = tangentOf(keys, i);
  k.to = k.ti;
  k.tm = true; // Unity 式默认：新固化的切线两侧联动
}

/** 清除手动切线（恢复自动 Catmull-Rom，并去掉对称标记） */
export function clearTangents(k: AnimKey): void {
  delete k.ti;
  delete k.to;
  delete k.tm;
}

/** 斜率钳制（±TANGENT_CLAMP；供编辑器写入手柄斜率） */
export function clampSlope(v: number): number {
  return clamp(v, -TANGENT_CLAMP, TANGENT_CLAMP);
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
    // 三次 Hermite：切线 = 手动 ti/to（贝塞尔编辑）优先，缺省自动 Catmull-Rom
    const m1 = keySlope(keys, i, "to") * span;
    const m2 = keySlope(keys, i + 1, "ti") * span;
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
): Map<AnimProp, number> {
  const out = new Map<AnimProp, number>();
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
