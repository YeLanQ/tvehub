import { describe, expect, it } from "vitest";
import {
  clampSlope,
  clearTangents,
  DEFAULT_CLIP_DURATION,
  emptyClipDoc,
  ensureManualTangents,
  evaluateClip,
  evaluateCurve,
  isAutoTangent,
  keySlope,
  keyWeight,
  parseAnimationClip,
  removeKeyAt,
  TANGENT_CLAMP,
  tangentWeightBase,
  upsertKey,
  type AnimClipCurve,
  type AnimKey,
} from "./clip";

// 关键帧动画剪辑：解析收敛、采样（linear/step/smooth）、区间钳制、循环回绕与编辑操作。

const curve = (keys: AnimKey[]): AnimClipCurve => ({ prop: "position.x", keys });
const k = (t: number, v: number, i: AnimKey["i"] = "linear", extra: Partial<AnimKey> = {}): AnimKey => ({ t, v, i, ...extra });

describe("parseAnimationClip 收敛", () => {
  it("非法输入回默认（null/数字/空对象）", () => {
    for (const bad of [null, undefined, 42, "x", {}]) {
      const c = parseAnimationClip(bad);
      expect(c.type).toBe("animclip");
      expect(c.name).toBe("Animation Clip");
      expect(c.duration).toBe(DEFAULT_CLIP_DURATION);
      expect(c.loops).toBe(true);
      expect(c.curves).toEqual([]);
    }
  });

  it("关键帧 t/v 非法剔除、插值非法回 linear、t 升序排序", () => {
    const c = parseAnimationClip({
      curves: [{ prop: "p", keys: [
        { t: 2, v: 20 },
        { t: "x", v: 1 },
        { t: 0, v: 0, i: "bogus" },
        { t: 1, v: NaN },
      ] }],
    });
    expect(c.curves[0].keys.map((key) => key.t)).toEqual([0, 2]);
    expect(c.curves[0].keys[0].i).toBe("linear");
  });

  it("通道去重、空 prop 剔除；时长钳制 [0.1, 3600]；loops 仅 false 关", () => {
    const c = parseAnimationClip({
      duration: 99999, loops: false,
      curves: [{ prop: "p", keys: [] }, { prop: "p", keys: [k(0, 1)] }, { prop: "", keys: [] }],
    });
    expect(c.curves).toHaveLength(1);
    expect(c.duration).toBe(3600);
    expect(c.loops).toBe(false);
    expect(parseAnimationClip({ duration: 0 }).duration).toBe(0.1);
  });

  it("切线斜率与手柄权重钳制", () => {
    const c = parseAnimationClip({ curves: [{ prop: "p", keys: [
      { t: 0, v: 0, ti: 9e9, to: -9e9, wi: 99, wo: 0 },
    ] }] });
    const key = c.curves[0].keys[0];
    expect(key.ti).toBe(TANGENT_CLAMP);
    expect(key.to).toBe(-TANGENT_CLAMP);
    expect(key.wi).toBeLessThanOrEqual(1.5);
    expect(key.wo).toBeGreaterThanOrEqual(0.01);
    expect(clampSlope(2e6)).toBe(TANGENT_CLAMP);
  });
});

describe("evaluateCurve 采样", () => {
  it("空曲线返回 null；区间外钳端点值", () => {
    expect(evaluateCurve(curve([]), 0)).toBeNull();
    const c = curve([k(1, 10), k(3, 30)]);
    expect(evaluateCurve(c, 0)).toBe(10);
    expect(evaluateCurve(c, 99)).toBe(30);
  });

  it("linear 中点插值；step 保持前值", () => {
    const lin = curve([k(0, 0), k(2, 10)]);
    expect(evaluateCurve(lin, 1)).toBeCloseTo(5, 9);
    const step = curve([k(0, 0, "step"), k(2, 10)]);
    expect(evaluateCurve(step, 1.999)).toBe(0);
    expect(evaluateCurve(step, 2)).toBe(10);
  });

  it("smooth 端点与中点连续（缺省权重时等价 Hermite）", () => {
    const c = curve([k(0, 0, "smooth"), k(1, 1, "smooth"), k(2, 0, "smooth")]);
    expect(evaluateCurve(c, 0)).toBeCloseTo(0, 9);
    expect(evaluateCurve(c, 1)).toBeCloseTo(1, 9);
    expect(evaluateCurve(c, 2)).toBeCloseTo(0, 9);
    const mid = evaluateCurve(c, 0.5);
    expect(mid).toBeGreaterThan(0); // 自动切线下中段应越过 0（Catmull-Rom 过冲）
  });

  it("手动切线覆盖自动切线", () => {
    const flat = curve([k(0, 0, "smooth", { to: 0 }), k(1, 1, "smooth", { ti: 0 })]);
    const mid = evaluateCurve(flat, 0.5);
    expect(mid).toBeCloseTo(0.5, 6); // 两端切线为 0 → S 形中点 0.5
  });

  it("非缺省手柄权重走 Bézier 时间反解路径（A≠0 三次 / A=0 二次）", () => {
    // 三次反解：两侧权重偏大（时间坐标仍单调）
    const cubicW = curve([
      k(0, 0, "smooth", { wo: 0.9 }),
      k(2, 4, "smooth", { wi: 0.9 }),
    ]);
    expect(evaluateCurve(cubicW, 0)).toBeCloseTo(0, 9);
    expect(evaluateCurve(cubicW, 2)).toBeCloseTo(4, 9);
    expect(evaluateCurve(cubicW, 1)).toBeCloseTo(2, 3); // 对称权重中点近似中值
    // 二次反解：w1+w2 = 2/3 且不全为缺省（A = 0）
    const quadW = curve([
      k(0, 0, "smooth", { wo: 0.5 }),
      k(2, 4, "smooth", { wi: 1 / 6 }),
    ]);
    expect(evaluateCurve(quadW, 1)).toBeCloseTo(2, 3);
  });

  it("keyWeight 对存储值二次钳制 / 非有限值回缺省", () => {
    expect(keyWeight([{ t: 0, v: 0, i: "smooth", wi: 99 } as AnimKey], 0, "ti")).toBeCloseTo(1.5, 9);
    expect(keyWeight([{ t: 0, v: 0, i: "smooth", wi: 0 } as AnimKey], 0, "ti")).toBeCloseTo(0.01, 9);
    expect(keyWeight([{ t: 0, v: 0, i: "smooth", wi: NaN } as AnimKey], 0, "ti")).toBeCloseTo(1 / 3, 9);
  });
});

describe("evaluateClip 循环回绕", () => {
  const clip = parseAnimationClip({ duration: 2, loops: true, curves: [{ prop: "p", keys: [k(0, 0), k(2, 20)] }] });

  it("loops 取模回绕（含负时间）", () => {
    expect(evaluateClip(clip, 2.5).get("p")).toBeCloseTo(5, 9);
    expect(evaluateClip(clip, -0.5).get("p")).toBeCloseTo(15, 9);
  });

  it("once 钳制末值；空通道不产出条目", () => {
    const once = parseAnimationClip({ duration: 2, loops: false, curves: [{ prop: "p", keys: [k(0, 0), k(2, 20)] }, { prop: "empty", keys: [] }] });
    expect(evaluateClip(once, 99).get("p")).toBe(20);
    expect(evaluateClip(once, 0).has("empty")).toBe(false);
  });
});

describe("切线工具", () => {
  it("keySlope：手动优先，否则 Catmull-Rom（端点单侧差分，单帧为 0）", () => {
    const keys = [k(0, 0), k(1, 2, "smooth"), k(3, 6, "smooth"), k(4, 8, "smooth", { ti: 100 })];
    expect(keySlope(keys, 1, "to")).toBeCloseTo(2, 6); // (6-0)/(3-0)
    expect(keySlope(keys, 0, "to")).toBeCloseTo(2, 6); // 单侧
    expect(keySlope(keys, 3, "ti")).toBe(100);
    expect(keySlope([k(0, 5)], 0, "to")).toBe(0);
  });

  it("ensureManualTangents 固化并联动；clearTangents 恢复自动", () => {
    const keys = [k(0, 0), k(1, 2, "smooth"), k(3, 6)];
    expect(isAutoTangent(keys[1])).toBe(true);
    ensureManualTangents(keys, 1);
    expect(keys[1].ti).toBeCloseTo(2, 6);
    expect(keys[1].tm).toBe(true);
    clearTangents(keys[1]);
    expect(isAutoTangent(keys[1])).toBe(true);
    expect(keys[1].tm).toBeUndefined();
  });

  it("keyWeight 缺省 1/3；tangentWeightBase 借用另一侧段跨", () => {
    const keys = [k(0, 0), k(2, 4, "smooth")];
    expect(keyWeight(keys, 0, "to")).toBeCloseTo(1 / 3, 9);
    expect(tangentWeightBase(keys, 0, "ti", 9)).toBe(2); // 左无帧 → 借右侧段
    expect(tangentWeightBase(keys, 1, "to", 9)).toBe(2);
    expect(tangentWeightBase([k(0, 1)], 0, "to", 9)).toBe(9); // 孤立单帧回退
  });
});

describe("编辑操作", () => {
  it("upsertKey 同帧覆盖（±1e-4）、新帧保持升序；removeKeyAt 就近删除", () => {
    const c = curve([]);
    upsertKey(c, 2, 20);
    upsertKey(c, 0, 0);
    upsertKey(c, 1, 10);
    expect(c.keys.map((key) => key.t)).toEqual([0, 1, 2]);
    upsertKey(c, 1.00005, 99);
    expect(c.keys).toHaveLength(3);
    expect(c.keys[1].v).toBe(99);
    expect(removeKeyAt(c, 0.00005)).toBe(true);
    expect(removeKeyAt(c, 5)).toBe(false);
    expect(c.keys.map((key) => key.t)).toEqual([1, 2]);
  });

  it("emptyClipDoc 生成合法空剪辑", () => {
    const doc = emptyClipDoc("新建");
    expect(doc).toEqual({ type: "animclip", name: "新建", duration: DEFAULT_CLIP_DURATION, loops: true, curves: [] });
  });
});
