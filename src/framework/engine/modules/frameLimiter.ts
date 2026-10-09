/**
 * 帧率上限器（Bresenham 数帧，与播放器 player.mjs 帧调度同算法）：
 * 启动期探测显示器刷新率——预热 10 帧后采 60 个帧距取中位数（排除 >100ms 异常
 * 帧距，首帧着色器编译/长任务不污染读数），按 cap/hz 比例给每帧配额、累积到 1
 * 渲染一帧。数帧不数时间：对 rAF 时间戳抖动完全免疫，比例配额在任意刷新率上
 * 精确锁到上限（60Hz 全渲零回归、90Hz→60、144Hz→60）。探测完成前（约 70 帧）
 * 按全速渲染：60Hz 屏即目标帧率，高刷屏只多渲约半秒。
 *
 * 消费方：编辑器视口活动期渲染（RendererManager.loop）与资产 3D 预览循环
 * （AssetPreview3D）——高刷屏上画布刷新过高是视口功耗/发热的直接来源。
 */
export class FrameRateLimiter {
  private lastT = -1;
  private warm = 0;
  private readonly deltas: number[] = [];
  /** 配额累积器：首帧即渲染 */
  private quota = 1;
  /** 每帧配额增量（cap/hz）；探测未完成 = 0（配额路径整体旁路，全速渲染） */
  private quotaInc = 0;

  constructor(private readonly cap: number) {}

  /** 每个 rAF 到达时调用一次；返回 true = 本帧应渲染 */
  tick(now: number): boolean {
    if (this.quotaInc === 0) {
      if (this.lastT < 0) {
        this.lastT = now;
        return true;
      }
      const d = now - this.lastT;
      this.lastT = now;
      if (d > 0 && d < 100) {
        if (this.warm < 10) this.warm++;
        else this.deltas.push(d);
        if (this.deltas.length >= 60) {
          const sorted = [...this.deltas].sort((a, b) => a - b);
          const hz = 1000 / sorted[Math.floor(sorted.length / 2)];
          // cap ≥ 实测刷新率 → 配额 1（全渲）；否则按比例（60 上限在 60Hz 屏零回归）
          this.quotaInc = Math.min(1, this.cap / Math.max(30, hz));
        }
      }
      return true;
    }
    this.quota += this.quotaInc;
    if (this.quota < 1) return false;
    this.quota -= 1;
    return true;
  }
}
