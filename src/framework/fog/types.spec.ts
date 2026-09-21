import { describe, expect, it } from "vitest";
import {
  cloneFogSettings,
  DEFAULT_FOG_SETTINGS,
  FOG_KINDS,
  fogKindLabel,
  FOG_LIMITS,
  fogSettingsSig,
  parseFogSettings,
} from "./types";

// 雾设置收敛：取值域钳制、克隆/签名与显示名。

describe("parseFogSettings", () => {
  it("非法输入回默认", () => {
    for (const bad of [null, "x", 3, {}]) {
      expect(parseFogSettings(bad)).toEqual(DEFAULT_FOG_SETTINGS);
    }
  });

  it("数值字段钳进取值域", () => {
    const s = parseFogSettings({ near: -1, far: 1e9, density: 5, heightY: 99999, heightFalloff: 0 });
    expect(s.near).toBe(FOG_LIMITS.near.min);
    expect(s.far).toBe(FOG_LIMITS.far.max);
    expect(s.density).toBe(FOG_LIMITS.density.max);
    expect(s.heightY).toBe(FOG_LIMITS.heightY.max);
    expect(s.heightFalloff).toBe(FOG_LIMITS.heightFalloff.min);
  });

  it("颜色钳 24 位（负数→0、超界→白、非数回默认）", () => {
    expect(parseFogSettings({ color: -3 }).color).toBe(0);
    expect(parseFogSettings({ color: 0x1ffffff }).color).toBe(0xffffff);
    expect(parseFogSettings({ color: "red" }).color).toBe(DEFAULT_FOG_SETTINGS.color);
  });

  it("合法输入往返稳定", () => {
    const src = { ...DEFAULT_FOG_SETTINGS, near: 5, far: 60, density: 0.05 };
    expect(parseFogSettings(src)).toEqual(src);
  });
});

describe("克隆 / 签名 / 显示名", () => {
  it("clone 独立；签名全字段参与", () => {
    const c = cloneFogSettings(DEFAULT_FOG_SETTINGS);
    c.density = 0.5;
    expect(DEFAULT_FOG_SETTINGS.density).toBe(0.02);
    const base = fogSettingsSig(DEFAULT_FOG_SETTINGS);
    expect(fogSettingsSig({ ...DEFAULT_FOG_SETTINGS, heightY: 3 })).not.toBe(base);
  });

  it("三种雾类型显示名", () => {
    expect(FOG_KINDS).toEqual(["linear", "exp2", "height"]);
    expect(fogKindLabel("linear")).toBe("Linear Fog");
    expect(fogKindLabel("exp2")).toBe("Exponential Fog");
    expect(fogKindLabel("height")).toBe("Height Fog");
  });
});
