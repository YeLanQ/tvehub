import { describe, expect, it } from "vitest";
import {
  applyLightShadowType,
  cloneLightShadow,
  DEFAULT_LIGHT_SHADOW,
  lightShadowSignature,
  lightShadowTypeOf,
  parseLightShadow,
  SHADOW_MAP_SIZE_CUBE,
  SHADOW_MAP_SIZE_PLANE,
  shadowMapSizeOf,
} from "./shadow";

// 阴影配置收敛与档位换算（纯数据层；渲染建出归 smoke 覆盖）。

describe("shadowMapSizeOf", () => {
  it("显式档位优先；0 = 自动（平面 4096 / 点光 1024）", () => {
    expect(shadowMapSizeOf(2048, true)).toBe(2048);
    expect(shadowMapSizeOf(512, false)).toBe(512);
    expect(shadowMapSizeOf(0, true)).toBe(SHADOW_MAP_SIZE_CUBE);
    expect(shadowMapSizeOf(0, false)).toBe(SHADOW_MAP_SIZE_PLANE);
  });
});

describe("parseLightShadow 收敛", () => {
  it("非法输入回默认", () => {
    expect(parseLightShadow(null)).toEqual(DEFAULT_LIGHT_SHADOW);
    expect(parseLightShadow(42)).toEqual(DEFAULT_LIGHT_SHADOW);
  });

  it("各字段钳制：强度 [0,1]、bias [-0.05,0]、near ≥0.01、radius [1,5]、分辨率白名单", () => {
    const s = parseLightShadow({
      strength: 2, bias: 0.1, normalBias: -1, near: -3, radius: 99, resolution: 777,
    });
    expect(s.strength).toBe(1);
    expect(s.bias).toBe(0);
    expect(s.normalBias).toBe(0);
    expect(s.near).toBe(0.01);
    expect(s.radius).toBe(5);
    expect(s.resolution).toBe(0); // 非白名单 → 自动
    expect(parseLightShadow({ radius: 0 }).radius).toBe(1);
    expect(parseLightShadow({ resolution: 4096 }).resolution).toBe(4096);
  });

  it("边界值保留（合法值不被误钳）", () => {
    const s = parseLightShadow({ strength: 0, bias: -0.05, near: 0.5, radius: 3 });
    expect(s).toMatchObject({ strength: 0, bias: -0.05, near: 0.5, radius: 3 });
  });
});

describe("Shadow 类型档位换算", () => {
  it("castShadow=false → off；radius ≥4 → soft、否则 hard", () => {
    expect(lightShadowTypeOf(false, DEFAULT_LIGHT_SHADOW)).toBe("off");
    expect(lightShadowTypeOf(true, { ...DEFAULT_LIGHT_SHADOW, radius: 4 })).toBe("soft");
    expect(lightShadowTypeOf(true, { ...DEFAULT_LIGHT_SHADOW, radius: 2 })).toBe("hard");
  });

  it("applyLightShadowType：hard/soft 写档位半径；off 只关投影保留半径", () => {
    expect(applyLightShadowType(DEFAULT_LIGHT_SHADOW, "hard")).toEqual({ castShadow: true, radius: 1 });
    expect(applyLightShadowType(DEFAULT_LIGHT_SHADOW, "soft")).toEqual({ castShadow: true, radius: 4 });
    const off = applyLightShadowType({ ...DEFAULT_LIGHT_SHADOW, radius: 5 }, "off");
    expect(off).toEqual({ castShadow: false, radius: 5 });
  });
});

describe("克隆与签名", () => {
  it("cloneLightShadow 独立副本；签名覆盖全部六字段", () => {
    const c = cloneLightShadow(DEFAULT_LIGHT_SHADOW);
    c.strength = 0.5;
    expect(DEFAULT_LIGHT_SHADOW.strength).not.toBe(0.5);
    const base = lightShadowSignature(DEFAULT_LIGHT_SHADOW);
    expect(lightShadowSignature(DEFAULT_LIGHT_SHADOW)).toBe(base);
    expect(lightShadowSignature({ ...DEFAULT_LIGHT_SHADOW, resolution: 2048 })).not.toBe(base);
  });
});
