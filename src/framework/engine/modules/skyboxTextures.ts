import * as THREE from "three";
import type { SkySunDisk } from "../../prototype/nodes/SkyboxNode";

/**
 * 天空盒背景纹理生成（编辑器视口用）。
 *
 * 程序化天空与默认立方体天空盒都由“节点上的参数”生成，无需外部贴图：
 * - procedural：等距柱状垂直渐变纹理（画布顶部=天顶、中部=地平线、底部=下方），
 *   作为 EquirectangularReflectionMapping 的 scene.background，任意相机位置
 *   看到的都是平滑天空渐变；可绘制太阳盘（high=光晕+亮盘 / simple=纯盘 / none=无）；
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

/** 程序化天空太阳参数 */
export interface SkySunSet {
  /** 太阳盘模式：high=光晕+亮盘 / simple=纯亮盘 / none=不绘制 */
  sunDisk?: SkySunDisk;
  /** 太阳颜色（RGB hex number；光晕使用同色淡出） */
  sunColor?: number;
  /** 太阳大小（圆盘半径，度） */
  sunSize?: number;
  /** 光晕强度 0~1（光晕半径与透明度随强度缩放） */
  sunGlow?: number;
  /** 太阳方位角（度；0 = +X 方向，逆时针转正，0~360） */
  sunAzimuth?: number;
  /** 太阳仰角（度；0 = 地平线，向上为正，0~90） */
  sunElevation?: number;
}

export type ProceduralSkyParams = SkyColorSet & SkySunSet;

/** number → "#rrggbb" */
function hex6(c: number): string {
  return "#" + (c & 0xffffff).toString(16).padStart(6, "0");
}

/** number → "r, g, b"（供 rgba() 使用；颜色取自太阳色，保证光晕与太阳同色） */
function rgbOf(c: number): string {
  const n = c & 0xffffff;
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

function rgbaOf(c: number, alpha: number): string {
  return `rgba(${rgbOf(c)}, ${alpha})`;
}

/** 程序化天空：等距柱状垂直渐变背景纹理（可选太阳） */
export function buildProceduralSkyTexture(sky: ProceduralSkyParams): THREE.CanvasTexture {
  const w = 256;
  const h = 512;
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
    drawProceduralSun(ctx, w, h, sky);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  // 横向循环：等距贴图的 0/1 列本是同一条经线（az ±180），太阳跨边界时不产生接缝
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

/**
 * 在等距柱状画布上绘制太阳（等角绘制，保证天空里是正圆而非被拉长的条）：
 * - 像素列：u = 0.5 + az/(2π)，az=0（+X 世界方向）位于画布中列；
 * - 像素行：v = el/π + 0.5，el>0 位于地平线以上（顶行=天顶）；
 * - 横向角分辨率 = w/360，纵向角分辨率 = h/180：同一角半径在画布上应为
 *   椭圆（rx = 角半径·w/360，ry = 角半径·h/180），通过 Y 向缩放把圆形渐变
 *   变成该椭圆，采样到天空后太阳恢复为正圆。
 */
function drawProceduralSun(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  sky: ProceduralSkyParams,
): void {
  const disk = sky.sunDisk ?? "high";
  if (disk === "none") return;
  const sizeDeg = sky.sunSize ?? 3;
  const azDeg = ((sky.sunAzimuth ?? 90) % 360 + 360) % 360;
  // 仰角支持整圈 0~360（90=天顶、180=对侧地平线、270=正下方、360=回到地平线）：
  // 归一到 [-90, 90] 的实际球面仰角，地平线以下不绘制
  const elCycle = (((sky.sunElevation ?? 25) % 360) + 360) % 360;
  const effEl = (Math.asin(Math.sin((elCycle * Math.PI) / 180)) * 180) / Math.PI;
  if (sizeDeg <= 0 || effEl < 0.5) return;
  const elDeg = Math.min(89, effEl);

  const u = 0.5 + azDeg / 360;
  const col = (((u % 1) + 1) % 1) * w;
  const v = elDeg / 180 + 0.5;
  const row = (1 - v) * (h - 1);
  // 同一角半径（sizeDeg）在画布横/纵的像素半径
  const rx = Math.max(0.5, (sizeDeg / 360) * w);
  const ry = Math.max(0.5, (sizeDeg / 180) * h);
  const sy = ry / rx;
  const R = rx;
  const color = (sky.sunColor ?? 0xffd27d) & 0xffffff;
  // 在 col 及左右 ±w 处各画一份：太阳靠近 0/1 列接缝时经 RepeatWrapping
  // 采样，边界两侧像素都能取到渐变，避免 180° 方位出现分界线/半圆
  const offsets = [-w, 0, w];
  for (const ox of offsets) {
    ctx.save();
    ctx.translate(col + ox, row);
    ctx.scale(1, sy);
    if (disk === "high") {
      // 光晕强度（0~1）：半径 = R*(0.6 + glow*2.4)，透明度随 glow 缩放
      const glowStrength = Math.max(0, Math.min(1, sky.sunGlow ?? 0.8));
      if (glowStrength > 0.001) {
        const glowR = R * (0.6 + glowStrength * 2.4);
        const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, glowR);
        glow.addColorStop(0, rgbaOf(color, Math.min(1, glowStrength + 0.2)));
        glow.addColorStop(0.4, rgbaOf(color, glowStrength * 0.9));
        glow.addColorStop(1, rgbaOf(color, 0));
        ctx.fillStyle = glow;
        ctx.fillRect(-glowR, -glowR, glowR * 2, glowR * 2);
      }
      // 白色高亮核心
      const core = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 1.2);
      core.addColorStop(0, "rgba(255,255,255,1)");
      core.addColorStop(0.5, "rgba(255,255,255,0.9)");
      core.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = core;
      ctx.fillRect(-R * 1.2, -R * 1.2, R * 2.4, R * 2.4);
    } else {
      // simple：太阳色纯亮盘（柔和边缘）
      const disc = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
      disc.addColorStop(0, rgbaOf(color, 1));
      disc.addColorStop(0.82, rgbaOf(color, 0.95));
      disc.addColorStop(1, rgbaOf(color, 0));
      ctx.fillStyle = disc;
      ctx.fillRect(-R, -R, R * 2, R * 2);
    }
    ctx.restore();
  }
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
