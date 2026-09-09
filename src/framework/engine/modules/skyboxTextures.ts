import * as THREE from "three";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import type { SkySunDisk } from "../../prototype/nodes/SkyboxNode";

/**
 * 天空盒背景纹理生成（编辑器视口用）。
 *
 * 程序化天空与默认三段式天空盒都由“节点上的参数”生成，无需外部贴图：
 * - procedural：等距柱状垂直渐变纹理（画布顶部=天顶、中部=地平线、底部=下方），
 *   作为 EquirectangularReflectionMapping 的 scene.background，任意相机位置
 *   看到的都是平滑天空渐变；可绘制太阳盘（high=光晕+亮盘 / simple=纯盘 / none=无）；
 * - cube：等距柱状三段纯色带（|仰角|>45° 为顶/底色，之间为地平线色），透视视觉
 *   与传统“顶/四面/底”六面纯色立方体完全一致（立方体的面分界就是 ±45° 仰角）；
 *   这是节点未绑定/未加载到 TextureCube 资产时的兜底表现。绑定 .texcube 后
 *   （loadTexCubeTexture）消费真实贴图：等距柱状全景图继续走等距柱状映射
 *   （透视背景与正交全屏面通用），六面模式生成 CubeTexture（正交全屏面按
 *   光线方向 cube 采样）。
 *
 * 两种纹理统一用等距柱状表示的原因：three.js 会把纹理背景（含 CubeTexture）
 * 转成立方体贴图后经“贴在相机位置的 1×1×1 反转盒”绘制——透视相机在盒内所以
 * 满屏，正交相机取景范围远大于盒子，天空盒只剩中间一小块。正交预览的天空改由
 * 引擎的全屏天空背景面（EditorEngine.updateOrthoSkyQuad）承担，按光线方向采样
 * 等距柱状纹理，故不再生成 CubeTexture。
 *
 * 网页预览运行时（public/engine/runtime/sky.mjs）按同一算法复刻，保证表现一致。
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

/**
 * 默认三段式天空盒：等距柱状纯色带纹理。
 * 分界取仰角 ±45°（v=0.25 / 0.75），与六面纯色立方体（顶=top / 四面=horizon /
 * 底=ground）透视视觉完全一致；同一位置写两个 stop 形成硬分界。
 */
export function buildBandSkyTexture(sky: SkyColorSet): THREE.CanvasTexture {
  const w = 4;
  const h = 64;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, hex6(sky.topColor));
    grad.addColorStop(0.25, hex6(sky.topColor));
    grad.addColorStop(0.25, hex6(sky.horizonColor));
    grad.addColorStop(0.75, hex6(sky.horizonColor));
    grad.addColorStop(0.75, hex6(sky.groundColor));
    grad.addColorStop(1, hex6(sky.groundColor));
    ctx.fillStyle = grad;
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

// ---------------------------------------------------------------------------
// TextureCube 资产（.texcube）加载：立方体天空盒的外部贴图。
// 引用路径经调用方解析为 asset:// 协议 URL（项目资产/内置资源同一入口）。
// ---------------------------------------------------------------------------

/** .texcube 六面键 */
export type TexCubeFaceKey = "px" | "nx" | "py" | "ny" | "pz" | "nz";

/** .texcube 文档（JSON；$type === "texcube"，由 Rust 序列化落盘） */
export interface TexCubeDoc {
  /** "equirect"（等距柱状全景图）| "faces"（六面贴图）；未知值按 equirect 处理 */
  source?: string;
  /** source=equirect：全景图相对路径（png/jpg/webp/bmp/hdr…） */
  map?: string;
  /** source=faces：六面贴图相对路径（空串 = 该面未设置） */
  faces?: Partial<Record<TexCubeFaceKey, string>>;
}

const TEXCUBE_FACE_KEYS: TexCubeFaceKey[] = ["px", "nx", "py", "ny", "pz", "nz"];

/** 天空盒材质（.mat）中引擎消费的字段（cube 与 procedural 分支） */
export interface SkyMatParams {
  kind: "cube" | "procedural";
  // —— cube ——
  /** TextureCube（.texcube）资产引用 */
  cubeMap: string;
  /** 天空旋转（度，绕世界 Y 轴） */
  rotation: number;
  /** 强度（背景亮度倍率） */
  strength: number;
  /** 世界不透明度（保留字段） */
  worldOpacity: number;
  /** 模糊（0~1） */
  blur: number;
  // —— procedural（Blender 天空纹理风格）——
  sunDisc: boolean;
  sunSize: number;
  sunStrength: number;
  sunElevation: number;
  sunRotation: number;
  altitude: number;
  air: number;
  dust: number;
  ozone: number;
  ms: boolean;
}

/** 拉取并解析天空盒材质参数（cube/procedural 均解析；非天空材质返回 null） */
export async function fetchSkyMatParams(url: string): Promise<SkyMatParams | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const doc = (await res.json()) as Record<string, unknown> | null;
    if (!doc || typeof doc !== "object" || doc.$type !== "material") return null;
    const kind = typeof doc.kind === "string" ? doc.kind : "";
    const shader = typeof doc.shader === "string" ? doc.shader : "";
    // 天空材质 shader 字段引用天空着色器资产；旧格式为魔法串（SkyBox/SkyProcedural），
    // kind 字段为渲染快路径判别（新老格式均写入）
    const shaderRef = shader.endsWith(".shader");
    const legacyProcedural =
      shader === "SkyProcedural" || (shaderRef && shader.includes("SkyProcedural"));
    if (kind !== "cube" && kind !== "procedural" && shader !== "SkyBox" && shader !== "SkyProcedural" && !shaderRef) {
      return null;
    }
    const num = (v: unknown, fallback: number): number =>
      typeof v === "number" && Number.isFinite(v) ? v : fallback;
    const bool = (v: unknown, fallback: boolean): boolean =>
      typeof v === "boolean" ? v : fallback;
    const str = (v: unknown, fallback: string): string =>
      typeof v === "string" ? v : fallback;
    return {
      kind: kind === "procedural" || legacyProcedural ? "procedural" : "cube",
      cubeMap: str(doc.cubeMap, ""),
      rotation: num(doc.rotation, 0),
      strength: num(doc.strength, 1),
      worldOpacity: num(doc.worldOpacity, 0),
      blur: num(doc.blur, 0),
      sunDisc: bool(doc.sunDisc, true),
      sunSize: num(doc.sunSize, 1),
      sunStrength: num(doc.sunStrength, 1),
      sunElevation: num(doc.sunElevation, 25),
      sunRotation: num(doc.sunRotation, 0),
      altitude: num(doc.altitude, 0),
      air: num(doc.air, 1),
      dust: num(doc.dust, 1),
      ozone: num(doc.ozone, 1),
      ms: bool(doc.ms, true),
    };
  } catch {
    return null;
  }
}

/** 拉取并解析 .texcube 文档（网络失败/非 texcube 文档返回 null） */
export async function fetchTexCubeDoc(url: string): Promise<TexCubeDoc | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const doc = (await res.json()) as (TexCubeDoc & { $type?: string }) | null;
    if (!doc || typeof doc !== "object" || doc.$type !== "texcube") return null;
    return doc;
  } catch {
    return null;
  }
}

/**
 * 按 .texcube 文档加载天空纹理：
 * - equirect：等距柱状全景图（.hdr 经 RGBELoader 解码为线性数据纹理，其余走
 *   图片解码）→ EquirectangularReflectionMapping，透视背景与正交全屏面同一直路；
 * - faces：六面图 → CubeTexture（透视背景直用；正交全屏面按光线方向 cube 采样）。
 * 引用缺失/加载失败返回 null（调用方回退三段色带兜底）。
 */
export async function loadTexCubeTexture(
  doc: TexCubeDoc,
  resolveUrl: (rel: string) => string | null,
): Promise<{ texture: THREE.Texture; isCube: boolean } | null> {
  if (doc.source === "faces") {
    const urls = TEXCUBE_FACE_KEYS.map((k) => {
      const rel = doc.faces?.[k] ?? "";
      return rel ? resolveUrl(rel) : null;
    });
    if (urls.some((u) => !u)) return null;
    const cube = await new THREE.CubeTextureLoader().loadAsync(urls as string[]);
    cube.colorSpace = THREE.SRGBColorSpace;
    return { texture: cube, isCube: true };
  }
  const rel = doc.map ?? "";
  if (!rel) return null;
  const url = resolveUrl(rel);
  if (!url) return null;
  if (/\.hdr$/i.test(rel)) {
    // .hdr（RGBE）：线性高动态数据纹理，色彩空间保持线性交由渲染合成映射
    const tex = await new RGBELoader().loadAsync(url);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    return { texture: tex, isCube: false };
  }
  const tex = await new THREE.TextureLoader().loadAsync(url);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  // 横向循环：等距贴图 0/1 列本是同一条经线，避免接缝；关闭 mipmap 减少闪烁
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return { texture: tex, isCube: false };
}
