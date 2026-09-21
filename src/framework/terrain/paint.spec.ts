import { describe, expect, it } from "vitest";
import {
  splatPixelToWorld,
  stampSplat,
  stampSplatLine,
  worldToSplatPixel,
  type SplatBuffer,
  type SplatBrush,
} from "./paint";

// 地形 splatmap 绘制：世界↔像素换算互逆、权重守恒与擦除/连线行为。

const SIZE = 100; // 地形边长 100m
const DIM = 33; // 33×33 像素

function whiteBuffer(): SplatBuffer {
  const data = new Uint8ClampedArray(DIM * DIM * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255; // 层 0（草地）满权重
  }
  return { data, width: DIM, height: DIM };
}

const at = (buf: SplatBuffer, px: number, py: number, c: number): number =>
  buf.data[(py * buf.width + px) * 4 + c];

const brush = (layer: number, over: Partial<SplatBrush> = {}): SplatBrush =>
  ({ layer, radius: 10, strength: 1, erase: false, ...over });

describe("世界 ↔ 像素换算", () => {
  it("像素对齐的世界坐标往返精确；任意坐标往返落在半像素量化误差内", () => {
    const halfPixel = SIZE / (DIM - 1) / 2;
    for (const px of [0, 8, 16, 32]) {
      const w = splatPixelToWorld(SIZE, DIM, px);
      expect(worldToSplatPixel(SIZE, DIM, w)).toBe(px);
    }
    for (const w of [12.34, -33.3, 47.7]) {
      const back = splatPixelToWorld(SIZE, DIM, worldToSplatPixel(SIZE, DIM, w));
      expect(Math.abs(back - w)).toBeLessThanOrEqual(halfPixel + 1e-9);
    }
    expect(worldToSplatPixel(SIZE, DIM, 0)).toBe((DIM - 1) / 2); // 中心
    expect(worldToSplatPixel(SIZE, DIM, -SIZE / 2)).toBe(0); // 西缘
    expect(worldToSplatPixel(SIZE, DIM, SIZE / 2)).toBe(DIM - 1); // 东缘
  });
});

describe("stampSplat 权重模型", () => {
  it("涂抹目标层：中心完全收敛、边缘衰减、总权重守恒 ≈255", () => {
    const buf = whiteBuffer();
    stampSplat(buf, SIZE, 0, 0, brush(1)); // 在中心把层 1（岩石）涂满
    const center = (DIM - 1) / 2;
    expect(at(buf, center, center, 1)).toBe(255);
    expect(at(buf, center, center, 0)).toBe(0);
    // 总权重守恒
    let sum = 0;
    for (let c = 0; c < 4; c++) sum += at(buf, center, center, c);
    expect(sum).toBe(255);
    // 远处不受影响
    expect(at(buf, 0, 0, 1)).toBe(0);
    expect(at(buf, 0, 0, 0)).toBe(255);
  });

  it("半径 0 / 地形尺寸 0 无副作用", () => {
    const buf = whiteBuffer();
    stampSplat(buf, SIZE, 0, 0, brush(1, { radius: 0 }));
    stampSplat(buf, 0, 0, 0, brush(1));
    expect(at(buf, 16, 16, 1)).toBe(0);
  });

  it("擦除模式：孤层像素权重均分给其余通道（不出全黑空洞）", () => {
    const buf = whiteBuffer();
    // 先把中心涂成层 1 独占
    stampSplat(buf, SIZE, 0, 0, brush(1));
    // 再擦除层 1：其余通道全为 0 时均分
    stampSplat(buf, SIZE, 0, 0, brush(1, { erase: true }));
    const center = (DIM - 1) / 2;
    let sum = 0;
    for (let c = 0; c < 4; c++) sum += at(buf, center, center, c);
    expect(at(buf, center, center, 1)).toBe(0);
    expect(sum).toBe(255);
  });
});

describe("stampSplatLine 连线", () => {
  it("沿线各点被覆盖（首尾中点均着色）", () => {
    const buf = whiteBuffer();
    stampSplatLine(buf, SIZE, -30, 0, 30, 0, brush(2));
    for (const w of [-30, -15, 0, 15, 30]) {
      const px = worldToSplatPixel(SIZE, DIM, w);
      expect(at(buf, px, (DIM - 1) / 2, 2), `x=${w}`).toBeGreaterThan(0);
    }
  });

  it("零长线段至少产生单章效果（实际盖两章收敛更快——已知小怪癖）", () => {
    const single = whiteBuffer();
    stampSplat(single, SIZE, 10, 10, brush(3));
    const line = whiteBuffer();
    stampSplatLine(line, SIZE, 10, 10, 10, 10, brush(3));
    const px = worldToSplatPixel(SIZE, DIM, 10);
    // 两章叠加只会更接近目标 255，不会弱于单章
    expect(at(line, px, px, 3)).toBeGreaterThanOrEqual(at(single, px, px, 3));
  });
});
