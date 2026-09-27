// ---------------------------------------------------------------------------
// RPI（Render Pipeline Interface）类型定义：RHI 之上的渲染管线标准接口。
//
// 管线负责"一帧怎么渲"：清除状态、分层多 pass 拆分、离屏目标与回贴。
// 视图描述（RPIViewDesc）里的 scene/camera 仍是不透明载荷（由 Framework
// 场景层持有）；RPI 不解释场景内容，只组织渲染流程。具体后端实现放在
// backends/ 下，替换渲染库时只动 backends/。
// ---------------------------------------------------------------------------

import type { RHIDevice, RHIRect, RHIRenderTarget } from "../rhi";

/**
 * 清除状态：本帧渲染开始时如何清屏。
 * - background：undefined = 不改动场景背景；null = 无背景（配合不清颜色保留
 *   上一帧画面）；其他值 = 由场景层给出的背景载荷（纯色/天空纹理）。
 */
export interface RPIClearDesc {
  color: boolean;
  depth: boolean;
  background?: unknown;
}

/** 一次视图渲染的描述（场景 + 相机 + 清除状态） */
export interface RPIViewDesc {
  scene: object;
  camera: object;
  clear?: RPIClearDesc;
}

/** 渲染管线：基于 RHI 设备组织的标准渲染流程 */
export interface RPIPipeline {
  readonly device: RHIDevice;

  /**
   * 渲染一个视图（主视图/离屏视图通用）：应用清除状态，按需拆分层多 pass
   * （相机掩码全开或单层占用时单 pass，零额外开销）。
   */
  renderView(view: RPIViewDesc): void;

  /** 叠加渲染（不清屏、不画背景，保留主视图画面；结束后恢复场景背景） */
  renderOverlay(view: RPIViewDesc): void;

  /** 渲染到离屏目标（画中画等；结束后回绑主画布） */
  renderToTarget(target: RHIRenderTarget, view: RPIViewDesc): void;

  /** 获取尺寸匹配的离屏目标（惰性创建/复用；half-float + MSAA4） */
  acquireTarget(width: number, height: number): RHIRenderTarget;

  /**
   * 把离屏目标纹理 scissor 回贴到主画布矩形（不清屏的绘制；WebGPU 清屏是
   * 整附件 loadOp 不受 scissor 控制，回贴必须走绘制路径）。
   */
  blitTarget(target: RHIRenderTarget, rect: RHIRect, viewW: number, viewH: number): void;

  dispose(): void;
}
