// 程序化/三段式天空盒：与编辑器 framework/engine/modules/skyboxTextures.ts 按同
// 一算法复刻，保证网页预览与编辑器视口表现一致。
import * as THREE from "./three.module.min.js";
import { num, matColor } from "./utils.mjs";

/** 天空盒节点默认配色（与编辑器 SkyboxNode.DEFAULT_SKYBOX_COLORS 一致） */
export const SKY_DEFAULTS = { top: 0x2f6fbb, horizon: 0xcfe4f7, ground: 0x8fa2b5 };

function skyHex(c) {
  return "#" + (c & 0xffffff).toString(16).padStart(6, "0");
}

function skyRgb(c) {
  const n = c & 0xffffff;
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

function skyRgba(c, alpha) {
  return `rgba(${skyRgb(c)}, ${alpha})`;
}

/** 程序化天空：等距柱状垂直渐变（顶=天顶 → 中=地平线 → 底=下方）+ 可选太阳，与编辑器一致 */
export function makeSkyEquirectTexture(top, horizon, ground, sun) {
  const w = 256;
  const h = 512;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, skyHex(top));
    g.addColorStop(0.5, skyHex(horizon));
    g.addColorStop(1, skyHex(ground));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    drawSkySun(ctx, w, h, sun || {});
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

/** 在等距柱状画布上绘制太阳（等角椭圆绘制，天空里保持正圆；与编辑器一致） */
function drawSkySun(ctx, w, h, sun) {
  const disk = sun.disk === "simple" || sun.disk === "none" ? sun.disk : "high";
  if (disk === "none") return;
  const sizeDeg = num(sun.size, 3);
  if (sizeDeg <= 0) return;
  const azDeg = ((num(sun.azimuth, 90) % 360) + 360) % 360;
  const elCycle = ((num(sun.elevation, 25) % 360) + 360) % 360;
  const effEl = (Math.asin(Math.sin((elCycle * Math.PI) / 180)) * 180) / Math.PI;
  if (effEl < 0.5) return;
  const elDeg = Math.min(89, effEl);
  const u = 0.5 + azDeg / 360;
  const col = (((u % 1) + 1) % 1) * w;
  const v = elDeg / 180 + 0.5;
  const row = (1 - v) * (h - 1);
  const rx = Math.max(0.5, (sizeDeg / 360) * w);
  const ry = Math.max(0.5, (sizeDeg / 180) * h);
  const sy = ry / rx;
  const R = rx;
  const color = matColor(sun.color, 0xffd27d);
  // 在 col 及左右 ±w 处各画一份：太阳靠近 0/1 列接缝时经 RepeatWrapping
  // 采样无缝衔接，避免 180° 方位出现分界线/半圆
  const offsets = [-w, 0, w];
  for (const ox of offsets) {
    ctx.save();
    ctx.translate(col + ox, row);
    ctx.scale(1, sy);
    if (disk === "high") {
      const glowStrength = Math.max(0, Math.min(1, num(sun.glow, 0.8)));
      if (glowStrength > 0.001) {
        const glowR = R * (0.6 + glowStrength * 2.4);
        const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, glowR);
        glow.addColorStop(0, skyRgba(color, Math.min(1, glowStrength + 0.2)));
        glow.addColorStop(0.4, skyRgba(color, glowStrength * 0.9));
        glow.addColorStop(1, skyRgba(color, 0));
        ctx.fillStyle = glow;
        ctx.fillRect(-glowR, -glowR, glowR * 2, glowR * 2);
      }
      const core = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 1.2);
      core.addColorStop(0, "rgba(255,255,255,1)");
      core.addColorStop(0.5, "rgba(255,255,255,0.9)");
      core.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = core;
      ctx.fillRect(-R * 1.2, -R * 1.2, R * 2.4, R * 2.4);
    } else {
      const disc = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
      disc.addColorStop(0, skyRgba(color, 1));
      disc.addColorStop(0.82, skyRgba(color, 0.95));
      disc.addColorStop(1, skyRgba(color, 0));
      ctx.fillStyle = disc;
      ctx.fillRect(-R, -R, R * 2, R * 2);
    }
    ctx.restore();
  }
}

/**
 * 默认三段式天空盒：等距柱状纯色带纹理（分界取仰角 ±45°，与六面纯色立方体
 * 的透视视觉完全一致——立方体的面分界就是 ±45° 仰角）。
 * 不用真正的 CubeTexture：three.js 把纹理背景（含 CubeTexture）统一转成立方体
 * 贴图后经“贴在相机位置的 1×1×1 反转盒”绘制，透视相机在盒内所以满屏，正交
 * 相机取景范围远大于盒子（天空盒只剩中间一小块）；正交时由 player.mjs 的
 * 全屏天空背景面按光线方向采样渲染，需要 2D 等距柱状纹理。
 */
export function makeSkyBandTexture(top, horizon, ground) {
  const w = 4;
  const h = 64;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    // 同一位置写两个 stop 形成硬分界（v: 0=天顶 → 0.25=仰角45° → 0.5=地平线）
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, skyHex(top));
    g.addColorStop(0.25, skyHex(top));
    g.addColorStop(0.25, skyHex(horizon));
    g.addColorStop(0.75, skyHex(horizon));
    g.addColorStop(0.75, skyHex(ground));
    g.addColorStop(1, skyHex(ground));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

/** 深度优先查找首个 type=skyboxNode 且 启用且可见 的节点（与编辑器 findSkyboxNode 一致） */
export function findSkyNode(json) {
  if (!json || typeof json !== "object") return null;
  if (json.type === "skyboxNode" && json.active !== false && json.visible !== false) return json;
  if (Array.isArray(json.children)) {
    for (const c of json.children) {
      const r = findSkyNode(c);
      if (r) return r;
    }
  }
  return null;
}

/** fetch 相对路径 → ImageBitmap（失败返回 null；归档/磁盘资产统一走 fetch 拦截）。
 * imageOrientation: "flipY" 必须显式指定——WebGL 对 ImageBitmap 上传忽略
 * UNPACK_FLIP_Y_WEBGL，不预翻转会导致纹理（天空全景/六面）垂直颠倒。 */
async function fetchImageBitmap(rel) {
  try {
    const r = await fetch(rel);
    if (!r.ok) return null;
    return await createImageBitmap(await r.blob(), { imageOrientation: "flipY" });
  } catch {
    return null;
  }
}

/**
 * TextureCube（.texcube）资产加载（与编辑器 loadTexCubeTexture 同规则）：
 * - source=equirect：等距柱状全景图（png/jpg/webp/bmp）→ EquirectangularReflectionMapping，
 *   透视背景与正交全屏天空面通用；
 * - source=faces：六面贴图 → CubeTexture（透视背景直用，正交全屏面按光线方向采样）；
 * - .hdr 网页运行时不解码（RGBE），返回 null 由调用方回退三段色带。
 */
export async function loadSkyTexCube(rel) {
  try {
    const r = await fetch(rel);
    if (!r.ok) return null;
    const doc = await r.json();
    if (!doc || typeof doc !== "object" || doc.$type !== "texcube") return null;
    if (doc.source === "faces") {
      const keys = ["px", "nx", "py", "ny", "pz", "nz"];
      const rels = keys.map((k) => doc.faces?.[k] ?? "");
      if (rels.some((v) => !v)) return null;
      const imgs = await Promise.all(rels.map(fetchImageBitmap));
      if (imgs.some((i) => !i)) return null;
      const cube = new THREE.CubeTexture(imgs);
      cube.colorSpace = THREE.SRGBColorSpace;
      cube.needsUpdate = true;
      return cube;
    }
    const mapRel = doc.map ?? "";
    if (!mapRel || /\.hdr$/i.test(mapRel)) return null;
    const bmp = await fetchImageBitmap(mapRel);
    if (!bmp) return null;
    const tex = new THREE.Texture(bmp);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  } catch {
    return null;
  }
}
