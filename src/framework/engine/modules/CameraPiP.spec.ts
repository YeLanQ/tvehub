import { describe, it, expect } from "vitest";
import { computePiPRect, PIP_MARGIN, PIP_BASE_WIDTH } from "./CameraPiP";

describe("computePiPRect", () => {
  it("常规视口：基准宽 280、高度按取景宽高比导出、右下边距为默认值", () => {
    const rect = computePiPRect(1600, 900, 16 / 9);
    expect(rect).not.toBeNull();
    expect(rect!.right).toBe(PIP_MARGIN);
    expect(rect!.bottom).toBe(PIP_MARGIN);
    expect(rect!.width).toBe(PIP_BASE_WIDTH);
    expect(rect!.height).toBe(Math.round(PIP_BASE_WIDTH / (16 / 9)));
  });

  it("竖向取景（aspect < 1）：高度超出可用区时按可用高度收窄宽度", () => {
    const rect = computePiPRect(800, 600, 0.5);
    expect(rect).not.toBeNull();
    // maxH = 600 - 24 = 576 > 280/0.5，未触发高度钳制 → 宽 280 高 560
    expect(rect!.width).toBe(280);
    expect(rect!.height).toBe(560);
  });

  it("矮视口：高度钳制到可用高度后宽度随比例收缩", () => {
    const rect = computePiPRect(1600, 120, 1);
    expect(rect).not.toBeNull();
    expect(rect!.height).toBe(120 - PIP_MARGIN * 2);
    expect(rect!.width).toBe(120 - PIP_MARGIN * 2);
  });

  it("视口过小（<80×60）返回 null：不绘制画中画", () => {
    expect(computePiPRect(79, 400, 1)).toBeNull();
    expect(computePiPRect(400, 59, 1)).toBeNull();
  });

  it("极端比例导致矩形退化（宽 <40）返回 null", () => {
    // maxW=76、maxH=46，aspect=0.5 → 高 46 时宽仅 23
    expect(computePiPRect(100, 70, 0.5)).toBeNull();
  });

  it("非法 aspect（0/负数/NaN）按 1 处理", () => {
    for (const aspect of [0, -2, NaN]) {
      const rect = computePiPRect(800, 600, aspect);
      expect(rect).not.toBeNull();
      expect(rect!.width).toBe(rect!.height);
    }
  });

  it("自定义边距与基准宽生效", () => {
    const rect = computePiPRect(1600, 900, 1, { margin: 4, baseWidth: 100 });
    expect(rect!.right).toBe(4);
    expect(rect!.bottom).toBe(4);
    expect(rect!.width).toBe(100);
    expect(rect!.height).toBe(100);
  });
});
