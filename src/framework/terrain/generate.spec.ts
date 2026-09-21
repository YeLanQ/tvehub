import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { bakeTerrainHeights, buildTerrain, sampleTerrainHeight, splitTerrainGeometry } from "./generate";
import { parseTerrainSettings } from "./types";

// 程序化地形烘焙：确定性、网格规模、雕刻叠加与高度采样/几何拆分。

const small = parseTerrainSettings({ segments: 32, size: 100, talusPasses: 0, seed: 7 });

describe("bakeTerrainHeights", () => {
  it("规模 = (segments+1)²；同种子逐位一致；不同种子不同", () => {
    const a = bakeTerrainHeights(small);
    const b = bakeTerrainHeights(small);
    expect(a.gridSize).toBe(33);
    expect(a.heights).toHaveLength(33 * 33);
    expect([...a.heights]).toEqual([...b.heights]);
    const other = bakeTerrainHeights(parseTerrainSettings({ ...small, seed: 8 }));
    expect([...other.heights]).not.toEqual([...a.heights]);
  });

  it("平坦化极限：heightScale=0 → 全零高度场", () => {
    const flat = bakeTerrainHeights(parseTerrainSettings({ ...small, heightScale: 0 }));
    expect(flat.heights.every((h) => h === 0)).toBe(true);
  });
});

describe("buildTerrain", () => {
  it("产出几何 + 纹理 + 高度数据，规模与设置一致", () => {
    const build = buildTerrain(small);
    expect(build.gridSize).toBe(33);
    expect(build.size).toBe(100);
    expect(build.heights).toHaveLength(33 * 33);
    expect(build.baseHeights).toHaveLength(33 * 33);
    expect(build.geometry.getAttribute("position")).toBeTruthy();
    expect(build.colorTexture.image).toBeTruthy();
    expect(build.maxY).toBeGreaterThanOrEqual(build.minY);
    build.geometry.dispose();
    build.colorTexture.dispose();
  });

  it("雕刻偏移叠加进最终高度（baseHeights 保持基准）", () => {
    const sculpt = new Float32Array(33 * 33).fill(5);
    const build = buildTerrain(small, null, sculpt);
    expect(build.heights[0]).toBeCloseTo(build.baseHeights[0] + 5, 6);
    build.geometry.dispose();
    build.colorTexture.dispose();
  });

  it("传入缓存基准高度时跳过程序化重烘焙（基准复用）", () => {
    const base = bakeTerrainHeights(small).heights;
    const build = buildTerrain(small, null, null, base);
    expect(build.baseHeights).toBe(base); // 直接复用引用（不再重新生成）
    build.geometry.dispose();
    build.colorTexture.dispose();
  });
});

describe("sampleTerrainHeight", () => {
  it("网格节点上取值 = 高度场原值；越界钳到边缘", () => {
    const build = buildTerrain(small);
    const n = build.gridSize;
    const half = build.size / 2;
    const step = build.size / build.segments;
    const wx = -half + 3 * step;
    const wz = -half + 4 * step;
    expect(sampleTerrainHeight(build, wx, wz)).toBeCloseTo(build.heights[4 * n + 3], 6);
    const edge = sampleTerrainHeight(build, 0, -half);
    const far = sampleTerrainHeight(build, 0, -9999);
    expect(far).toBeCloseTo(edge, 6); // 越界 = 边缘钳制
    build.geometry.dispose();
    build.colorTexture.dispose();
  });
});

describe("splitTerrainGeometry", () => {
  it("chunks≤1 或无索引几何原样返回", () => {
    const build = buildTerrain(small);
    expect(splitTerrainGeometry(build.geometry, build.size, 1)).toEqual([build.geometry]);
    const noIndex = new THREE.BufferGeometry();
    noIndex.setAttribute("position", build.geometry.getAttribute("position"));
    expect(splitTerrainGeometry(noIndex, build.size, 2)).toEqual([noIndex]);
    noIndex.dispose();
    build.geometry.dispose();
    build.colorTexture.dispose();
  });

  it("按 chunks² 拆出子几何且三角形不重不漏（总索引数守恒）", () => {
    const build = buildTerrain(small);
    const parts = splitTerrainGeometry(build.geometry, build.size, 2);
    expect(parts).toHaveLength(4);
    const total = parts.reduce((n, g) => n + (g.getIndex()?.count ?? 0), 0);
    expect(total).toBe(build.geometry.getIndex()!.count);
    build.geometry.dispose();
    build.colorTexture.dispose();
  });
});
