// ---------------------------------------------------------------------------
// 分层渲染 pass（Culling Mask 多 pass 实现，运行时镜像）。
//
// 相机掩码全开且无部分掩码灯光、或在掩码内只占用一个层时单 pass（零额外开销）；
// 相机节点收窄了 Culling Mask 且场景占用多个掩码内层时按层拆 pass —— 每个 pass
// 收窄相机 layers 到单层，three 的灯光收集判定（light.layers.test(相机层)）使每盏
// 灯只照亮其掩码内的层。后续 pass 不清屏、不画背景、天空背景面只在首个 pass 绘制。
// 与编辑器 src/framework/engine/modules/layerPass.ts 同一算法（两边运行时独立，
// 无法共享模块，保持镜像；改动需两侧同步）。
// ---------------------------------------------------------------------------

/** 收集场景中可见可渲染体占用的层位掩码（网格/线/点/精灵；不可见子树跳过） */
export function populatedLayerBits(scene) {
  let bits = 0;
  scene.traverseVisible((o) => {
    if (o.isMesh === true || o.isLine === true || o.isPoints === true || o.isSprite === true) {
      bits |= o.layers.mask;
    }
  });
  return bits;
}

/**
 * 相机本帧需要的分层 pass 位列表（升序，每项为单层位掩码）；
 * 返回 null = 无需拆分，调用方照常单 pass。
 * 相机掩码全开且无部分掩码灯光、或掩码内在用层 ≤1 → null；
 * 相机掩码全开但存在部分掩码灯光且场景占用多层 → 仍按层拆（Culling Mask 语义下灯光
 * Culling Mask 恒生效，与相机掩码无关；每层 pass 只收集掩码覆盖该层的灯）。
 */
export function layerPassBits(scene, camera) {
  const populated = populatedLayerBits(scene);
  const bitsOf = (bits) => {
    const out = [];
    for (let i = 0; i < 32; i++) {
      if (bits & (1 << i)) out.push(1 << i);
    }
    return out;
  };
  if (camera.layers.mask === -1) {
    let hasPartialLight = false;
    let anyLight = false;
    scene.traverseVisible((o) => {
      if (o.isLight === true) {
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

/** 多 pass 渲染中，后续 pass 需要隐藏的"天空背景面"标记（userData 键） */
export const SKY_ONLY_FIRST_PASS = "skyOnlyFirstPass";

/**
 * 按分层 pass 渲染场景（layerPassBits 返回非 null 时调用）：
 * 首个 pass 按调用方已就位的清除状态/背景正常绘制；后续 pass 收窄相机层、
 * 不清屏、不画背景（scene.background 置空）、隐藏天空背景面，叠加绘制。
 * 结束后恢复相机层掩码/背景/autoClear 标志。
 */
export function renderLayerPasses(renderer, scene, camera, bits) {
  const prevMask = camera.layers.mask;
  const prevBg = scene.background;
  const prevClearColor = renderer.autoClearColor;
  const prevClearDepth = renderer.autoClearDepth;
  const skyQuads = [];
  scene.traverse((o) => {
    if (o.userData && o.userData[SKY_ONLY_FIRST_PASS] === true && o.visible) skyQuads.push(o);
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
