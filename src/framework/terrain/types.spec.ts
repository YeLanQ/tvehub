import { describe, expect, it } from "vitest";
import {
  cloneTerrainSettings,
  DEFAULT_TERRAIN_SETTINGS,
  isTerrainAssetRel,
  parseTerrainSettings,
  TERRAIN_LIMITS,
  terrainSettingsSig,
} from "./types";

// 地形设置收敛：缺省回退、越界钳制、克隆与重建签名。

describe("parseTerrainSettings", () => {
  it("非法输入整体回默认", () => {
    for (const bad of [null, 42, "x", {}]) {
      expect(parseTerrainSettings(bad)).toEqual(DEFAULT_TERRAIN_SETTINGS);
    }
  });

  it("数值字段钳进取值域（min/max 边界保留）", () => {
    const s = parseTerrainSettings({
      seed: 1e9, size: -5, segments: 7, heightScale: 999,
      frequency: 0, octaves: 99, speed: "x",
    });
    expect(s.seed).toBeLessThanOrEqual(TERRAIN_LIMITS.seed.max);
    expect(s.size).toBe(TERRAIN_LIMITS.size.min);
    expect(s.segments).toBeGreaterThanOrEqual(TERRAIN_LIMITS.segments.min);
    expect(s.segments).toBeLessThanOrEqual(TERRAIN_LIMITS.segments.max);
    expect(s.heightScale).toBeLessThanOrEqual(TERRAIN_LIMITS.heightScale.max);
    expect(s.frequency).toBeGreaterThanOrEqual(TERRAIN_LIMITS.frequency.min);
    expect(s.octaves).toBe(TERRAIN_LIMITS.octaves.max);
  });

  it("颜色字段收敛到 24 位（负数/超界钳制，非数回默认色）", () => {
    const s = parseTerrainSettings({ grassColor: 0x123456, rockColor: -1, snowColor: 0x1ffffff });
    expect(s.grassColor).toBe(0x123456);
    expect(s.rockColor).toBe(0); // 负数钳到 0（黑）
    expect(s.snowColor).toBe(0xffffff);
    expect(parseTerrainSettings({ rockColor: "red" }).rockColor).toBe(DEFAULT_TERRAIN_SETTINGS.rockColor);
  });

  it("合法值原样保留（往返稳定）", () => {
    const src = { ...DEFAULT_TERRAIN_SETTINGS, seed: 42, size: 200, segments: 64 };
    expect(parseTerrainSettings(src)).toEqual(src);
    expect(parseTerrainSettings(parseTerrainSettings(src))).toEqual(src);
  });
});

describe("克隆 / 签名 / 资产路径", () => {
  it("cloneTerrainSettings 产出独立副本", () => {
    const a = cloneTerrainSettings(DEFAULT_TERRAIN_SETTINGS);
    a.seed = 7;
    expect(DEFAULT_TERRAIN_SETTINGS.seed).not.toBe(7);
  });

  it("terrainSettingsSig：任一字段变化签名必变；同设置签名稳定", () => {
    const base = terrainSettingsSig(DEFAULT_TERRAIN_SETTINGS);
    expect(terrainSettingsSig(DEFAULT_TERRAIN_SETTINGS)).toBe(base);
    const changed = cloneTerrainSettings(DEFAULT_TERRAIN_SETTINGS);
    changed.seed += 1;
    expect(terrainSettingsSig(changed)).not.toBe(base);
    changed.seed -= 1;
    changed.snowColor = 0x000001;
    expect(terrainSettingsSig(changed)).not.toBe(base);
  });

  it("isTerrainAssetRel 按扩展名（大小写不敏感）", () => {
    expect(isTerrainAssetRel("env/map.terrain")).toBe(true);
    expect(isTerrainAssetRel("env/map.TERRAIN")).toBe(true);
    expect(isTerrainAssetRel("env/map.terrainmat")).toBe(false);
    expect(isTerrainAssetRel("env/map")).toBe(false);
  });
});
