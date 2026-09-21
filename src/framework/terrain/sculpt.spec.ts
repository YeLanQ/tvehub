import { describe, expect, it } from "vitest";
import {
  decodeSculptData,
  encodeSculptData,
  parseTerrainSculpt,
  stampSculpt,
  type SculptBrush,
} from "./sculpt";

// 地形雕刻：base64 编解码往返、层数据收敛与四种笔刷模式的效果方向。

const GRID = 16;
const SIZE = 60;

function zeros(): Float32Array {
  return new Float32Array(GRID * GRID);
}

const brush = (mode: SculptBrush["mode"], over: Partial<SculptBrush> = {}): SculptBrush =>
  ({ mode, radius: 10, strength: 1, ...over });

describe("parseTerrainSculpt 收敛", () => {
  it("合法数据保留（gridN 2..1024 整数 + 非空 data）", () => {
    const d = parseTerrainSculpt({ gridN: 64, data: "AAAA" });
    expect(d).toEqual({ gridN: 64, data: "AAAA" });
  });

  it("非法返回 null：非对象 / gridN 越界或非整数 / 空 data", () => {
    expect(parseTerrainSculpt(null)).toBeNull();
    expect(parseTerrainSculpt({ gridN: 1, data: "x" })).toBeNull();
    expect(parseTerrainSculpt({ gridN: 2000, data: "x" })).toBeNull();
    expect(parseTerrainSculpt({ gridN: 16.5, data: "x" })).toBeNull();
    expect(parseTerrainSculpt({ gridN: 16, data: "" })).toBeNull();
    expect(parseTerrainSculpt({ gridN: 16 })).toBeNull();
  });
});

describe("encode / decode 往返", () => {
  it("Float32 偏移 → base64 → Float32 逐位还原", () => {
    const src = new Float32Array([0, 1.5, -2.25, 3.14159, 1e-7]);
    const back = decodeSculptData(encodeSculptData(src));
    expect(back).not.toBeNull();
    expect([...back!]).toEqual([...src]);
  });

  it("损坏的 base64 返回 null", () => {
    expect(decodeSculptData("!!!not-base64!!!")).toBeNull();
  });

  it("长度非 4 字节对齐的解码产物为 null 或短数组（不抛错）", () => {
    expect(() => decodeSculptData("AAA")).not.toThrow();
  });
});

describe("stampSculpt 四种模式", () => {
  it("raise：中心抬升、远处不动", () => {
    const offsets = zeros();
    const base = zeros();
    stampSculpt(offsets, base, GRID, SIZE, 0, 0, brush("raise"), 0);
    const mid = (GRID / 2) * GRID + GRID / 2;
    expect(offsets[mid]).toBeGreaterThan(0);
    expect(offsets[0]).toBe(0); // 角落在半径外
  });

  it("lower：方向相反", () => {
    const offsets = zeros();
    stampSculpt(offsets, zeros(), GRID, SIZE, 0, 0, brush("lower"), 0);
    const mid = (GRID / 2) * GRID + GRID / 2;
    expect(offsets[mid]).toBeLessThan(0);
  });

  it("flatten：组合高度向目标高度收敛", () => {
    const base = zeros();
    base[10 * GRID + 8] = 5; // 一根孤峰
    const offsets = zeros();
    stampSculpt(offsets, base, GRID, SIZE, 0, 0, brush("flatten"), 0); // targetY = 0
    const i = 10 * GRID + 8;
    const after = base[i] + offsets[i];
    expect(after).toBeLessThan(5); // 向 0 收敛
    expect(after).toBeGreaterThanOrEqual(0);
  });

  it("smooth：孤峰被邻域均值拉低、谷被拉高", () => {
    const base = zeros();
    const i = 8 * GRID + 8;
    base[i] = 10;
    const offsets = zeros();
    stampSculpt(offsets, base, GRID, SIZE, 0, 0, brush("smooth"), 0);
    expect(base[i] + offsets[i]).toBeLessThan(10);
  });

  it("守卫：半径 0 / 尺寸 0 / 网格 <2 无副作用", () => {
    const offsets = zeros();
    stampSculpt(offsets, zeros(), GRID, 0, 0, 0, brush("raise"), 0);
    stampSculpt(offsets, zeros(), GRID, SIZE, 0, 0, brush("raise", { radius: 0 }), 0);
    stampSculpt(offsets, zeros(), 1, SIZE, 0, 0, brush("raise"), 0);
    expect(offsets.every((v) => v === 0)).toBe(true);
  });
});
