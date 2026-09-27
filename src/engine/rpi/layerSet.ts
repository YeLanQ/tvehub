// ---------------------------------------------------------------------------
// 分层渲染 pass 计算（Culling Mask 的多 pass 实现，RPI 层纯函数）。
//
// 渲染库的相机层裁剪是原生的（object.layers.test(camera.layers)），但灯光只有
// "灯层 vs 相机层" 的收集判定：灯光 uniform 是整帧全局的，没有"灯只照亮所选层"
// 的逐对象过滤。严格的 Culling Mask 语义按「在用层」拆多次渲染：每个 pass 把
// 渲染相机的 layers 收窄到单个层位 —— 收集灯光时 light.layers.test(camera.layers)
// 恰好就完成了"这盏灯只参与其掩码内层的 pass"，无需逐灯开关。
//
// 相机掩码全开（编辑器自由视角 / 默认相机）且无部分掩码灯光时恒单 pass，行为
// 与开销同单次渲染；场景只占用一个在掩码内的层时同样单 pass。后续 pass 不清屏、
// 不画背景、skyOnlyFirstPass 的天空背景面只在首个 pass 绘制。
//
// 本模块用结构化鸭子类型（不 import three），可被任意满足形状的场景图使用，
// 单测用普通对象桩即可覆盖。
// ---------------------------------------------------------------------------

/** 多 pass 渲染中，后续 pass 需要隐藏的"天空背景面"标记名（userData 键） */
export const SKY_ONLY_FIRST_PASS = "skyOnlyFirstPass";
/** 多 pass 渲染中，后续 pass 需要隐藏的"UI 画布"标记名（叠加半透明重复绘制会变浓） */
export const UI_ONLY_FIRST_PASS = "uiOnlyFirstPass";

/** 场景图节点（结构化鸭子类型；three Object3D 天然满足） */
export interface LayerNodeLike {
  visible: boolean;
  layers?: { mask: number };
  userData?: Record<string, unknown>;
  isLight?: boolean;
  isMesh?: boolean;
  isLine?: boolean;
  isPoints?: boolean;
  isSprite?: boolean;
}

/** 场景（结构化鸭子类型；three Scene 天然满足） */
export interface LayerSceneLike {
  background: unknown;
  traverse(cb: (o: LayerNodeLike) => void): void;
  traverseVisible(cb: (o: LayerNodeLike) => void): void;
}

/** 相机（只需要层掩码） */
export interface LayerCameraLike {
  layers: { mask: number };
}

/** 分层渲染所需的最小设备面（RHI 设备天然满足） */
export interface LayerPassDevice {
  render(scene: object, camera: object): void;
  setAutoClear(color: boolean, depth: boolean): void;
}

/** 层位掩码 → 升序单层位列表（每项是单层位掩码） */
export function bitsOf(bits: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 32; i++) {
    if (bits & (1 << i)) out.push(1 << i);
  }
  return out;
}

/** 收集场景中可见可渲染体占用的层位掩码（网格/线/点/精灵；不可见子树跳过） */
export function populatedLayerBits(scene: LayerSceneLike): number {
  let bits = 0;
  scene.traverseVisible((o) => {
    if (o.isMesh || o.isLine || o.isPoints || o.isSprite) {
      bits |= o.layers ? o.layers.mask : 0;
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
 * - 掩码全开但存在部分掩码灯光且场景占用多层 → 仍按层拆：Culling Mask 语义下
 *   灯光 Culling Mask 恒生效，拆分后每层 pass 只收集掩码覆盖该层的灯。
 *
 * 渲染体占用层与（掩码全开时的）灯光部分掩码标记在**单次** traverseVisible 内
 * 同时收集（常见单 pass 路径每帧一次全树遍历）。
 */
export function computeLayerPassBits(
  scene: LayerSceneLike,
  camera: LayerCameraLike,
): number[] | null {
  const fullMask = camera.layers.mask === -1;
  let populated = 0;
  let anyLight = false;
  let hasPartialLight = false;
  scene.traverseVisible((o) => {
    if (o.isLight === true) {
      anyLight = true;
      if (o.layers && o.layers.mask !== -1) hasPartialLight = true;
      return;
    }
    if (o.isMesh || o.isLine || o.isPoints || o.isSprite) {
      populated |= o.layers ? o.layers.mask : 0;
    }
  });
  if (fullMask) {
    if (!anyLight || !hasPartialLight) return null;
    const bits = bitsOf(populated);
    return bits.length > 1 ? bits : null;
  }
  const need = populated & camera.layers.mask;
  if (need === 0) return null;
  const bits = bitsOf(need);
  return bits.length > 1 ? bits : null;
}

/**
 * 按分层 pass 渲染场景（computeLayerPassBits 返回非 null 时调用）：
 * 首个 pass 按调用方已就位的清除状态/背景正常绘制；后续 pass 收窄相机层、
 * 不清屏、不画背景（scene.background 置空）、隐藏天空背景面与 UI 画布，叠加绘制。
 * 结束后恢复相机层掩码/背景/清屏标志（恢复到 baseClear 给出的主 pass 状态）。
 */
export function renderLayerSet(
  device: LayerPassDevice,
  scene: LayerSceneLike,
  camera: LayerCameraLike,
  bits: number[],
  baseClear: { color: boolean; depth: boolean },
): void {
  const prevMask = camera.layers.mask;
  const prevBg = scene.background;
  const firstPassOnly: LayerNodeLike[] = [];
  scene.traverse((o) => {
    const ud = o.userData;
    if (ud && (ud[SKY_ONLY_FIRST_PASS] === true || ud[UI_ONLY_FIRST_PASS] === true) && o.visible) {
      firstPassOnly.push(o);
    }
  });
  try {
    bits.forEach((bit, i) => {
      camera.layers.mask = bit;
      if (i > 0) {
        scene.background = null;
        device.setAutoClear(false, false);
        firstPassOnly.forEach((q) => {
          q.visible = false;
        });
      }
      device.render(scene, camera);
    });
  } finally {
    camera.layers.mask = prevMask;
    scene.background = prevBg;
    device.setAutoClear(baseClear.color, baseClear.depth);
    firstPassOnly.forEach((q) => {
      q.visible = true;
    });
  }
}
