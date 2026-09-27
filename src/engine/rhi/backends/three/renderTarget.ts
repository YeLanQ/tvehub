// RHI three 后端共享：渲染目标包装（WebGL/WebGPU 设备共用；RenderTarget
// 类来自 three core，两种构建共享 three.core，跨后端互用——见 stage 侧约定）。
import * as THREE from "three";
import type { RHIRenderTarget, RHIRenderTargetDesc } from "../../types";

/** 渲染目标包装：three RenderTarget → RHI 不透明句柄 */
export class ThreeRenderTarget implements RHIRenderTarget {
  readonly desc: RHIRenderTargetDesc;
  readonly handle: unknown;
  constructor(private readonly rt: THREE.RenderTarget) {
    this.desc = {
      width: rt.width,
      height: rt.height,
      format:
        (rt.texture as THREE.Texture).type === THREE.HalfFloatType ? "half-float" : "unsigned-byte",
      samples: rt.samples,
      depthBuffer: rt.depthBuffer,
    };
    this.handle = rt;
  }
  get texture(): unknown {
    return this.rt.texture;
  }
  resize(width: number, height: number): void {
    this.rt.setSize(width, height);
    this.desc.width = width;
    this.desc.height = height;
  }
  dispose(): void {
    this.rt.dispose();
  }
}
