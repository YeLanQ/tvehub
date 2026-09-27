// ---------------------------------------------------------------------------
// 分层渲染 pass（framework 兼容出口）：实现在 RPI 层 src/engine/rpi/layerSet.ts
// （设备无关纯函数，编辑器与播放运行时共用同一份）。本文件保留 three 类型
// 签名的再导出供 framework 侧引用；新代码直接 import engine/rpi/layerSet。
// ---------------------------------------------------------------------------
import type * as THREE from "three";
import {
  SKY_ONLY_FIRST_PASS,
  UI_ONLY_FIRST_PASS,
  computeLayerPassBits,
  populatedLayerBits as rpiPopulatedLayerBits,
} from "../../../engine/rpi/layerSet";
import type { LayerCameraLike, LayerSceneLike } from "../../../engine/rpi/layerSet";

export { SKY_ONLY_FIRST_PASS, UI_ONLY_FIRST_PASS };

/** 收集场景中可见可渲染体占用的层位掩码（网格/线/点/精灵；不可见子树跳过） */
export function populatedLayerBits(scene: THREE.Object3D): number {
  return rpiPopulatedLayerBits(scene as unknown as LayerSceneLike);
}

/**
 * 相机本帧需要的分层 pass 位列表（升序；每项是单层位掩码）。
 * 返回 null = 无需拆分，调用方照常单 pass（语义详见 engine/rpi/layerSet）。
 */
export function layerPassBits(
  scene: THREE.Object3D,
  camera: THREE.Camera,
): number[] | null {
  return computeLayerPassBits(
    scene as unknown as LayerSceneLike,
    camera as unknown as LayerCameraLike,
  );
}
