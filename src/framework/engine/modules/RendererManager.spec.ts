import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RendererManager } from "./RendererManager";

// 空闲降帧的活动信号判定（不 mount：纯时间戳 + 钩子聚合，无 WebGL 依赖）。
// 渲染循环据 viewportActive 在空闲时降频（IDLE_FPS）、交互/活动内容恢复全速。
describe("RendererManager 空闲降帧活动信号", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("空闲超窗后判定空闲，交互标记立即恢复活动", () => {
    const rm = new RendererManager();
    vi.advanceTimersByTime(5000);
    expect(rm.viewportActive()).toBe(false);
    rm.markActivity();
    expect(rm.viewportActive()).toBe(true);
  });

  it("活动钩子为真（动画播放/物理模拟等）时空闲窗口外仍保持全速", () => {
    const rm = new RendererManager();
    rm.addActivityHook(() => true);
    vi.advanceTimersByTime(5000);
    expect(rm.viewportActive()).toBe(true);
  });

  it("全部活动钩子为假且超窗后判定空闲（渲染循环据此降帧）", () => {
    const rm = new RendererManager();
    rm.addActivityHook(() => false);
    rm.addActivityHook(() => false);
    vi.advanceTimersByTime(5000);
    expect(rm.viewportActive()).toBe(false);
  });

  it("任一活动钩子翻真即从空闲翻回活动（播放动画恢复全速的边沿）", () => {
    const rm = new RendererManager();
    let playing = false;
    rm.addActivityHook(() => playing);
    vi.advanceTimersByTime(5000);
    expect(rm.viewportActive()).toBe(false);
    playing = true;
    expect(rm.viewportActive()).toBe(true);
  });
});
