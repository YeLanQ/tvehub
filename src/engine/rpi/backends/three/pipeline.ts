// ---------------------------------------------------------------------------
// RPI three 后端：基于 RHI 设备的标准渲染管线实现。
// 承接原 framework/layerPass.ts + CameraPiPPass 的管线职责（清除状态应用、
// 分层多 pass、离屏 RT 与 scissor 回贴）；three 相关细节（背景面标记、全屏
// 三角形回贴）全部收拢在此，上层只调 RPIPipeline。
// ---------------------------------------------------------------------------

import * as THREE from "three";
import type { RHIDevice, RHIRect, RHIRenderTarget } from "../../../rhi";
import {
  computeLayerPassBits,
  renderLayerSet,
  type LayerCameraLike,
  type LayerSceneLike,
} from "../../layerSet";
import type { RPIPipeline, RPIViewDesc } from "../../types";

/** 离屏目标默认规格：HalfFloat 保存线性 HDR 值 + MSAA×4 近似主画布抗锯齿 */
const TARGET_FORMAT = "half-float" as const;
const TARGET_SAMPLES = 4;

/** 创建 three 管线（renderView/renderOverlay/renderToTarget/acquireTarget/blitTarget） */
export function createThreePipeline(device: RHIDevice): RPIPipeline {
  let target: RHIRenderTarget | null = null;
  let blitMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null = null;
  const blitScene = new THREE.Scene();
  const blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);

  function applyClear(view: RPIViewDesc): { color: boolean; depth: boolean } {
    const clear = view.clear;
    if (!clear) {
      // 无清除描述 = 默认全清（与旧渲染路径的缺省行为一致），背景不动
      device.setAutoClear(true, true);
      return { color: true, depth: true };
    }
    if (clear.background !== undefined) {
      (view.scene as LayerSceneLike).background = clear.background;
    }
    device.setAutoClear(clear.color, clear.depth);
    return { color: clear.color, depth: clear.depth };
  }

  const pipeline: RPIPipeline = {
    device,

    renderView(view: RPIViewDesc): void {
      const baseClear = applyClear(view);
      const scene = view.scene as LayerSceneLike;
      const camera = view.camera as LayerCameraLike;
      const bits = computeLayerPassBits(scene, camera);
      if (!bits) {
        device.render(view.scene, view.camera);
      } else {
        renderLayerSet(device, scene, camera, bits, baseClear);
      }
    },

    renderOverlay(view: RPIViewDesc): void {
      const scene = view.scene as LayerSceneLike;
      const prevBg = scene.background;
      try {
        pipeline.renderView({ ...view, clear: { color: false, depth: false, background: null } });
      } finally {
        scene.background = prevBg;
      }
    },

    renderToTarget(rt: RHIRenderTarget, view: RPIViewDesc): void {
      device.setRenderTarget(rt);
      try {
        pipeline.renderView(view);
      } finally {
        device.setRenderTarget(null);
      }
    },

    acquireTarget(width: number, height: number): RHIRenderTarget {
      const w = Math.max(1, Math.round(width));
      const h = Math.max(1, Math.round(height));
      if (!target) {
        target = device.createRenderTarget({
          width: w,
          height: h,
          format: TARGET_FORMAT,
          samples: TARGET_SAMPLES,
          depthBuffer: true,
        });
      } else if (target.desc.width !== w || target.desc.height !== h) {
        target.resize(w, h);
      }
      return target;
    },

    blitTarget(rt: RHIRenderTarget, rect: RHIRect, viewW: number, viewH: number): void {
      const mesh = ensureBlitMesh();
      const mat = mesh.material;
      if (mat.map !== (rt.texture as THREE.Texture | null)) {
        mat.map = rt.texture as THREE.Texture;
        mat.needsUpdate = true;
      }
      // 回贴不清屏：WebGPU 的清屏是整附件 loadOp 不受 scissor 控制，会毁掉主视图；
      // scissor/viewport 入参即逻辑像素，与 RT 设备像素分辨率按像素比一一对应
      device.setScissorTest(true);
      device.setScissor(rect);
      device.setViewport(rect);
      device.setAutoClear(false, false);
      device.render(blitScene, blitCam);
      device.setScissorTest(false);
      device.setViewport({ x: 0, y: 0, width: viewW, height: viewH });
    },

    dispose(): void {
      target?.dispose();
      target = null;
      if (blitMesh) {
        blitMesh.geometry.dispose();
        blitMesh.material.dispose();
        blitMesh = null;
      }
    },
  };

  /** 回贴四边形：全屏三角形铺满视口（配 ±1 正交相机），不读写深度 */
  function ensureBlitMesh(): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
    if (!blitMesh) {
      blitMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false }),
      );
      blitMesh.frustumCulled = false;
      blitScene.add(blitMesh);
    }
    return blitMesh;
  }

  return pipeline;
}
