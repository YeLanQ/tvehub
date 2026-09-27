// ---------------------------------------------------------------------------
// 画中画（PiP）渲染 pass（framework 层，跨渲染后端）。
//
// 相机节点被选中时在编辑视口右下角内嵌该相机的取景画面。实现采用
// 「离屏 RenderTarget 渲染 + scissor 回贴」而非同画布 scissor 直绘：
// WebGPU 后端的清屏是渲染通道整附件 loadOp（不受 scissor 裁剪），直绘清屏会把
// 主视图整体刷成画中画背景；先渲到独立 RT（整附件清屏无副作用），再用全屏
// 三角形把 RT 纹理 scissor 裁剪回贴主画布矩形——回贴是绘制不是清屏，两种后端
// 语义一致。RT 用 HalfFloat 保存线性 HDR 值，回贴材质 toneMapped 使 HDR/LDR
// 与主视图输出一致（three 仅在渲染到屏幕时应用 toneMapping/输出编码）。
// ---------------------------------------------------------------------------

import * as THREE from "three";

/** 画中画矩形（CSS 像素；right/bottom 为距视口右/下边的偏移，与 DOM 浮层定位一致） */
export interface PiPRect {
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** 画中画渲染请求（引擎按选中相机节点逐帧解析；null = 本帧无画中画） */
export interface PiPRequest {
  camera: THREE.Camera;
  rect: PiPRect;
  /** 渲染前隐藏编辑器辅助物（网格/gizmo/辅助线），渲染后复原 */
  begin(): void;
  end(): void;
}

/** PiP 矩形默认参数：右边距/下边距 12px，基准宽 280px，按取景宽高比导出高度 */
export const PIP_MARGIN = 12;
export const PIP_BASE_WIDTH = 280;

/**
 * 按取景宽高比计算右下角画中画矩形（纯函数；渲染 pass 与 DOM 浮层共用口径）。
 * 视口过小或矩形退化（极端比例/超小视口）时返回 null = 不绘制。
 */
export function computePiPRect(
  viewW: number,
  viewH: number,
  aspect: number,
  opts?: { margin?: number; baseWidth?: number },
): PiPRect | null {
  const margin = opts?.margin ?? PIP_MARGIN;
  const baseWidth = opts?.baseWidth ?? PIP_BASE_WIDTH;
  const safeAspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  if (viewW < 80 || viewH < 60) return null;
  const maxW = viewW - margin * 2;
  const maxH = viewH - margin * 2;
  let width = Math.min(baseWidth, maxW);
  let height = width / safeAspect;
  if (height > maxH) {
    height = maxH;
    width = height * safeAspect;
  }
  if (width < 40 || height < 30) return null;
  return {
    right: margin,
    bottom: margin,
    width: Math.round(width),
    height: Math.round(height),
  };
}

/** 离屏渲染所需的渲染器最小接口（WebGLRenderer / WebGPURenderer 共有） */
export interface PiPRendererLike {
  setRenderTarget(target: THREE.RenderTarget | null): void;
  setScissor(x: number, y: number, w: number, h: number): void;
  setViewport(x: number, y: number, w: number, h: number): void;
  setScissorTest(test: boolean): void;
  autoClearColor: boolean;
  autoClearDepth: boolean;
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
}

/**
 * 画中画 pass：离屏 RT 生命周期 + 回贴四边形。
 * 调用时序（每帧，主渲染完成之后）：
 *   beginRenderTarget → [调用方就位清除状态并渲染场景] → endRenderTarget → blit
 */
export class CameraPiPPass {
  private rt: THREE.RenderTarget | null = null;
  private rtW = 0;
  private rtH = 0;
  private blitScene = new THREE.Scene();
  private blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  private blitMat: THREE.MeshBasicMaterial | null = null;

  /** 绑定离屏 RT（按设备像素尺寸惰性创建/重建；MSAA×4 近似主画布抗锯齿） */
  beginRenderTarget(r: PiPRendererLike, width: number, height: number): void {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (!this.rt) {
      this.rt = new THREE.RenderTarget(w, h, {
        type: THREE.HalfFloatType,
        samples: 4,
        depthBuffer: true,
      });
      this.rtW = w;
      this.rtH = h;
    } else if (this.rtW !== w || this.rtH !== h) {
      this.rt.setSize(w, h);
      this.rtW = w;
      this.rtH = h;
    }
    r.setRenderTarget(this.rt);
  }

  /** 结束离屏渲染（回绑主画布） */
  endRenderTarget(r: PiPRendererLike): void {
    r.setRenderTarget(null);
  }

  /** scissor 回贴：把 RT 纹理全屏绘制进主画布的画中画矩形（入参均为 CSS 像素；
   *  three 的 scissor/viewport 入参即逻辑像素，内部再乘像素比，与 RT 设备像素
   *  分辨率恰好一一对应） */
  blit(r: PiPRendererLike, rect: PiPRect, viewW: number, viewH: number): void {
    if (!this.rt) return;
    const mat = this.ensureBlitMaterial();
    if (mat.map !== this.rt.texture) {
      mat.map = this.rt.texture;
      mat.needsUpdate = true;
    }
    const x = viewW - rect.right - rect.width;
    const y = rect.bottom;
    r.setScissorTest(true);
    r.setScissor(x, y, rect.width, rect.height);
    r.setViewport(x, y, rect.width, rect.height);
    // 回贴不清屏：WebGPU 的清屏是整附件 loadOp 不受 scissor 控制，会毁掉主视图
    r.autoClearColor = false;
    r.autoClearDepth = false;
    r.render(this.blitScene, this.blitCam);
    r.setScissorTest(false);
    r.setViewport(0, 0, viewW, viewH);
  }

  dispose(): void {
    this.rt?.dispose();
    this.rt = null;
    this.blitMat?.dispose();
    this.blitMat = null;
  }

  /** 回贴材质：全屏三角形铺满视口（配 ±1 正交相机），不读写深度 */
  private ensureBlitMaterial(): THREE.MeshBasicMaterial {
    if (!this.blitMat) {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false }),
      );
      mesh.frustumCulled = false;
      this.blitScene.add(mesh);
      this.blitMat = mesh.material as THREE.MeshBasicMaterial;
    }
    return this.blitMat;
  }
}
