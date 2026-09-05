import * as THREE from "three";

/**
 * 天空盒背景纹理生成（编辑器视口用）。
 *
 * 程序化天空与默认立方体天空盒都由“节点上的三色参数”生成，无需外部贴图：
 * - procedural：等距柱状渐变纹理（画布顶部=天顶、中部=地平线、底部=下方），
 *   作为 EquirectangularReflectionMapping 的 scene.background，任意相机位置
 *   看到的都是平滑天空渐变；
 * - cube：六面纯色 CubeTexture（顶=top / 四面=horizon / 底=ground），
 *   作为 scene.background 的默认立方体贴图天空。
 *
 * 网页预览运行时（public/web-preview/player.mjs）按同一算法复刻，保证表现一致。
 */

/** 天空颜色三元组（RGB hex number） */
export interface SkyColorSet {
  topColor: number;
  horizonColor: number;
  groundColor: number;
}

/** number → "#rrggbb" */
function hex6(c: number): string {
  return "#" + (c & 0xffffff).toString(16).padStart(6, "0");
}

/** 程序化天空：等距柱状垂直渐变背景纹理 */
export function buildProceduralSkyTexture(sky: SkyColorSet): THREE.CanvasTexture {
  const w = 8;
  const h = 256;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    // 画布从上到下 = 天顶 → 地平线(正中) → 下方(地面)
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, hex6(sky.topColor));
    grad.addColorStop(0.5, hex6(sky.horizonColor));
    grad.addColorStop(1, hex6(sky.groundColor));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

function solidCanvas(color: string, size = 4): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, size, size);
  }
  return canvas;
}

/** 默认立方体天空盒：六面纯色 CubeTexture（px/nx/pz/nz=侧面色，py=顶，ny=底） */
export function buildCubeSkyTexture(sky: SkyColorSet): THREE.CubeTexture {
  const side = solidCanvas(hex6(sky.horizonColor));
  const top = solidCanvas(hex6(sky.topColor));
  const bottom = solidCanvas(hex6(sky.groundColor));
  // CubeTexture 图片顺序：+x, -x, +y, -y, +z, -z
  const tex = new THREE.CubeTexture([side, side, top, bottom, side, side]);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
