import { describe, expect, it } from "vitest";
import { FrameRateLimiter } from "./frameLimiter";

// Bresenham 数帧限频器：探测刷新率（预热 10 + 采样 60 帧距取中位数）后按
// cap/hz 比例配额。测试用固定帧距模拟 rAF 时间戳序列，统计渲染比例。
describe("FrameRateLimiter", () => {
  it("首帧即渲染（quota 初始 1）", () => {
    const lim = new FrameRateLimiter(60);
    expect(lim.tick(0)).toBe(true);
  });

  it("60Hz 帧距下每帧都渲染（零回归）", () => {
    const lim = new FrameRateLimiter(60);
    let rendered = 0;
    const total = 210; // 探测期 70 帧 + 探测后 140 帧
    for (let i = 0; i < total; i++) {
      if (lim.tick(16.667 * i)) rendered++;
    }
    expect(rendered).toBe(total);
  });

  it("144Hz 帧距下稳态平均锁到 60fps（比例配额 Bresenham）", () => {
    const lim = new FrameRateLimiter(60);
    let rendered = 0;
    const step = 1000 / 144;
    const probe = 71; // 首帧 + 预热 10 + 采样 60（探测期全速属启动瞬态，不入稳态分母）
    const total = probe + 1440; // 稳态 10 秒
    for (let i = 0; i < total; i++) {
      // 每 tick 都要喂（探测依赖连续帧距），只统计探测完成后的稳态段
      if (lim.tick(step * i) && i >= probe) rendered++;
    }
    const fps = rendered / ((step * (total - probe)) / 1000);
    expect(fps).toBeGreaterThan(57);
    expect(fps).toBeLessThan(63);
  });

  it("90Hz 帧距下稳态平均锁到 60fps", () => {
    const lim = new FrameRateLimiter(60);
    let rendered = 0;
    const step = 1000 / 90;
    const probe = 71;
    const total = probe + 900; // 稳态 10 秒
    for (let i = 0; i < total; i++) {
      if (lim.tick(step * i) && i >= probe) rendered++;
    }
    const fps = rendered / ((step * (total - probe)) / 1000);
    expect(fps).toBeGreaterThan(57);
    expect(fps).toBeLessThan(63);
  });

  it("探测期异常帧距（>100ms，暂停恢复/长任务）不污染中位数", () => {
    const lim = new FrameRateLimiter(60);
    let rendered = 0;
    let now = 0;
    // 前 35 帧正常，中间插 3 个 500ms 巨大帧距（都不该计入采样），再正常走完
    for (let i = 0; i < 35; i++) {
      now += 16.667;
      if (lim.tick(now)) rendered++;
    }
    for (let i = 0; i < 3; i++) {
      now += 500;
      if (lim.tick(now)) rendered++;
    }
    const total = 70 + 140;
    while (rendered < total) {
      now += 16.667;
      if (lim.tick(now)) rendered++;
    }
    // 中位数未被污染 → 60Hz 判定 → 后续全渲（若污染则配额 <1 会丢帧）
    for (let i = 0; i < 200; i++) {
      now += 16.667;
      if (lim.tick(now)) rendered++;
      else break;
    }
    expect(rendered).toBe(total + 200);
  });

  it("cap 不低于刷新率时探测后全速渲染（cap 144 屏 60Hz）", () => {
    const lim = new FrameRateLimiter(144);
    let rendered = 0;
    const total = 210;
    for (let i = 0; i < total; i++) {
      if (lim.tick(16.667 * i)) rendered++;
    }
    expect(rendered).toBe(total);
  });
});
