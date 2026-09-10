// ---------------------------------------------------------------------------
// 分层渲染 pass 计算（Culling Mask 的多 pass 实现，framework 层纯函数）。
//
// three.js 的相机层裁剪是原生的（object.layers.test(camera.layers)），但灯光只有
// "灯层 vs 相机层" 的收集判定：灯光 uniform 是整帧全局的，没有"灯只照亮所选层"
// 的逐对象过滤。严格的 Culling Mask 语义按「在用层」拆多次渲染：每个 pass 把渲染相机的
// layers 收窄到单个层位 —— three 收集灯光时 light.layers.test(camera.layers)
// 恰好就完成了"这盏灯只参与其掩码内层的 pass"，无需逐灯开关；阴影相机层随灯
// cullingMask 同步（见 SceneSynchronizer.configureShadowLight）。
//
// 相机掩码全开（编辑器自由视角 / 默认相机）且无部分掩码灯光时恒单 pass，行为
// 与开销同旧版；场景只占用一个在掩码内的层时同样单 pass。后续 pass 不清屏、
// 不画背景、userData.skyOnlyFirstPass 的天空背景面只在首个 pass 绘制。
// ---------------------------------------------------------------------------

import * as THREE from "three";

/** 收集场景中可见可渲染体占用的层位掩码（网格/线/点/精灵；不可见子树跳过） */
export function populatedLayerBits(scene: THREE.Object3D): number {
  let bits = 0;
  scene.traverseVisible((o) => {
    const anyObj = o as THREE.Object3D & {
      isMesh?: boolean;
      isLine?: boolean;
      isPoints?: boolean;
      isSprite?: boolean;
    };
    if (anyObj.isMesh || anyObj.isLine || anyObj.isPoints || anyObj.isSprite) {
      bits |= o.layers.mask;
    }
  });
  return bits;
}

/**
 * 相机本帧需要的分层 pass 位列表（升序；每项是单层位掩码）。
 * 返回 null = 无需拆分，调用方照常单 pass。
 *
 * - 相机掩码全开（编辑器自由视角 / 默认相机）且无部分掩码灯光 → null（零开销）；
 * - 掩码内的在用层 ≤1 → null；
 * - 相机收窄了掩码且掩码内占用多层 → 按层拆（对象裁剪 + 灯光过滤一体生效）；
 * - 掩码全开但存在部分掩码灯光且场景占用多层 → 仍按层拆：Culling Mask 语义下灯光
 *   Culling Mask 恒生效（掩码全开的相机只是"看得到所有层"，灯光仍只照亮所选层），
 *   拆分后每层 pass 只收集掩码覆盖该层的灯。
 */
export function layerPassBits(scene: THREE.Object3D, camera: THREE.Camera): number[] | null {
  const populated = populatedLayerBits(scene);
  const bitsOf = (bits: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < 32; i++) {
      if (bits & (1 << i)) out.push(1 << i);
    }
    return out;
  };
  if (camera.layers.mask === -1) {
    // 相机掩码全开：只有存在"部分掩码灯光"且场景占用多层时才需要拆分
    let hasPartialLight = false;
    let anyLight = false;
    scene.traverseVisible((o) => {
      if ((o as THREE.Light).isLight === true) {
        anyLight = true;
        if (o.layers.mask !== -1) hasPartialLight = true;
      }
    });
    if (!anyLight || !hasPartialLight) return null;
    const bits = bitsOf(populated);
    return bits.length > 1 ? bits : null;
  }
  const need = populated & camera.layers.mask;
  if (need === 0) return null;
  const bits = bitsOf(need);
  return bits.length > 1 ? bits : null;
}

/** 多 pass 渲染中，后续 pass 需要隐藏的"天空背景面"标记名（userData 键） */
export const SKY_ONLY_FIRST_PASS = "skyOnlyFirstPass";

/**
 * 按分层 pass 渲染场景（layerPassBits 返回非 null 时调用）：
 * 首个 pass 按调用方已就位的清除状态/背景正常绘制；后续 pass 收窄相机层、
 * 不清屏、不画背景（scene.background 置空）、隐藏天空背景面，叠加绘制。
 * 结束后恢复相机层掩码/背景/autoClear 标志。
 */
export function renderLayerPasses(
  renderer: {
    autoClearColor: boolean;
    autoClearDepth: boolean;
    render(scene: THREE.Object3D, camera: THREE.Camera): void;
  },
  scene: THREE.Scene,
  camera: THREE.Camera,
  bits: number[],
): void {
  const prevMask = camera.layers.mask;
  const prevBg = scene.background;
  const prevClearColor = renderer.autoClearColor;
  const prevClearDepth = renderer.autoClearDepth;
  const skyQuads: THREE.Object3D[] = [];
  scene.traverse((o) => {
    if ((o.userData as Record<string, unknown>)[SKY_ONLY_FIRST_PASS] === true && o.visible) {
      skyQuads.push(o);
    }
  });
  try {
    bits.forEach((bit, i) => {
      camera.layers.mask = bit;
      if (i > 0) {
        scene.background = null;
        renderer.autoClearColor = false;
        renderer.autoClearDepth = false;
        skyQuads.forEach((q) => {
          q.visible = false;
        });
      }
      renderer.render(scene, camera);
    });
  } finally {
    camera.layers.mask = prevMask;
    scene.background = prevBg;
    renderer.autoClearColor = prevClearColor;
    renderer.autoClearDepth = prevClearDepth;
    skyQuads.forEach((q) => {
      q.visible = true;
    });
  }
}
