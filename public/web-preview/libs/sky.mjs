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

/** 拉取并解析天空盒材质参数（.mat；仅识别天空材质，其它返回 null） */
export async function loadSkyMatParams(rel) {
  try {
    const r = await fetch(rel);
    if (!r.ok) return null;
    const doc = await r.json();
    if (!doc || typeof doc !== "object" || doc.$type !== "material") return null;
    const kind = typeof doc.kind === "string" ? doc.kind : "";
    const shader = typeof doc.shader === "string" ? doc.shader : "";
    if (
      kind !== "cube" &&
      kind !== "procedural" &&
      shader !== "SkyBox" &&
      shader !== "SkyProcedural"
    ) {
      return null;
    }
    const num = (v, f) => (typeof v === "number" && Number.isFinite(v) ? v : f);
    const bool = (v, f) => (typeof v === "boolean" ? v : f);
    const str = (v, f) => (typeof v === "string" ? v : f);
    return {
      kind: kind === "procedural" || shader === "SkyProcedural" ? "procedural" : "cube",
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

// —— Nishita 程序化天空生成（与编辑器 framework/engine/modules/nishitaSky.ts 同一算法）——
const NISHITA_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;
const NISHITA_FRAG = `
  varying vec2 vUv;
  uniform vec3 sunPosition;
  uniform float rayleigh;
  uniform float mie;
  uniform float ozone;
  uniform float altitude;
  uniform float mieDirectionalG;
  uniform float sunDisc;
  uniform float sunSize;
  uniform float sunStrength;
  uniform float ms;
  uniform vec3 up;
  const float e = 2.718281828459045;
  const float pi = 3.141592653589793;
  const vec3 lambda = vec3(680E-9, 550E-9, 450E-9);
  const vec3 totalRayleigh = vec3(5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5);
  const vec3 K = vec3(0.686, 0.678, 0.666);
  const vec3 MieConst = vec3(1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14);
  const float cutoffAngle = 1.6110731556870734;
  const float steepness = 1.5;
  const float EE = 1000.0;
  const float rayleighZenithLength = 8.4E3;
  const float mieZenithLength = 1.25E3;
  const float THREE_OVER_SIXTEENPI = 0.05968310365946075;
  const float ONE_OVER_FOURPI = 0.07957747154594767;
  float sunIntensity(float zenithAngleCos) {
    zenithAngleCos = clamp(zenithAngleCos, -1.0, 1.0);
    return EE * max(0.0, 1.0 - pow(e, -((cutoffAngle - acos(zenithAngleCos)) / steepness)));
  }
  vec3 totalMie(float T) {
    float c = (0.2 * T) * 10E-18;
    return 0.434 * c * MieConst;
  }
  float rayleighPhase(float cosTheta) {
    return THREE_OVER_SIXTEENPI * (1.0 + pow(cosTheta, 2.0));
  }
  float hgPhase(float cosTheta, float g) {
    float g2 = pow(g, 2.0);
    float inverse = 1.0 / pow(1.0 - 2.0 * g * cosTheta + g2, 1.5);
    return ONE_OVER_FOURPI * ((1.0 - g2) * inverse);
  }
  void main() {
    float phi = (vUv.x - 0.5) * 2.0 * pi;
    float sy = sin((vUv.y - 0.5) * pi);
    float sr = sqrt(max(0.0, 1.0 - sy * sy));
    vec3 direction = normalize(vec3(sr * cos(phi), sy, sr * sin(phi)));
    vec3 sunDir = normalize(sunPosition);
    float density = exp(-max(altitude, 0.0) / 8500.0);
    float sunfade = 1.0 - clamp(1.0 - exp((sunPosition.y / 450000.0)), 0.0, 1.0);
    float rayleighCoefficient = rayleigh * density - (1.0 * (1.0 - sunfade));
    vec3 betaR = totalRayleigh * max(rayleighCoefficient, 0.0);
    vec3 betaM = totalMie(2.0) * mie * density;
    float upDot = dot(up, direction);
    float below = smoothstep(0.0, 0.35, -upDot);
    float airmassUpDot = mix(upDot, abs(upDot), below);
    float zenithAngle = acos(clamp(airmassUpDot, -1.0, 1.0));
    float inverse = 1.0 / (cos(zenithAngle) + 0.15 * pow(93.885 - ((zenithAngle * 180.0) / pi), -1.253));
    float sR = rayleighZenithLength * inverse;
    float sM = mieZenithLength * inverse;
    vec3 Fex = exp(-(betaR * sR + betaM * sM));
    vec3 betaOz = ozone * vec3(0.650, 1.881, 0.085) * 2.5E-5;
    Fex *= exp(-betaOz * sR * 0.35);
    float cosTheta = dot(direction, sunDir);
    vec3 betaRTheta = betaR * rayleighPhase(cosTheta * 0.5 + 0.5);
    vec3 betaMTheta = betaM * hgPhase(cosTheta, mieDirectionalG);
    float sunE = sunIntensity(dot(sunDir, up));
    vec3 Lin = pow(sunE * ((betaRTheta + betaMTheta) / (betaR + betaM)) * (1.0 - Fex), vec3(1.5));
    Lin *= mix(vec3(1.0), pow(sunE * ((betaRTheta + betaMTheta) / (betaR + betaM)) * Fex, vec3(1.0 / 2.0)), clamp(pow(1.0 - dot(up, sunDir), 5.0), 0.0, 1.0));
    Lin *= mix(1.0, 0.22, below);
    vec3 L0 = vec3(0.1) * Fex;
    float halfSin = sin(radians(max(sunSize, 0.01)) * 0.5);
    float sunCos = cos(radians(max(sunSize, 0.01)) * 0.5);
    float sundisc = smoothstep(sunCos, sunCos + max(0.0001, halfSin * 0.12), cosTheta) * sunDisc;
    L0 += (sunE * 19000.0 * Fex * sunStrength) * sundisc;
    vec3 texColor = (Lin + L0) * 0.04 + vec3(0.0, 0.0003, 0.00075);
    texColor += ms * (1.0 - Fex) * 0.035 * vec3(0.55, 0.7, 1.0) * (sunE / EE);
    // 输出线性 HDR：色调映射交给渲染端（与编辑器 nishitaSky 同规则）
    gl_FragColor = vec4(texColor, 1.0);
  }
`;

let nishitaRT = null;
let nishitaScene = null;
let nishitaCam = null;

/** 按 Nishita 参数渲染等距柱状天空纹理（线性 HDR；参数结构与编辑器一致） */
export function makeNishitaSkyEquirect(renderer, params) {
  if (!nishitaScene) {
    nishitaScene = new THREE.Scene();
    nishitaCam = new THREE.Camera();
    nishitaCam.projectionMatrix.identity();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    const material = new THREE.ShaderMaterial({
      vertexShader: NISHITA_VERT,
      fragmentShader: NISHITA_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        sunPosition: { value: new THREE.Vector3(1, 0.4, 0) },
        rayleigh: { value: 1 },
        mie: { value: 1 },
        ozone: { value: 1 },
        altitude: { value: 0 },
        mieDirectionalG: { value: 0.8 },
        sunDisc: { value: 1 },
        sunSize: { value: 1 },
        sunStrength: { value: 1 },
        ms: { value: 1 },
        up: { value: new THREE.Vector3(0, 1, 0) },
      },
    });
    nishitaScene.add(new THREE.Mesh(geometry, material));
    nishitaScene.userData.material = material;
    nishitaRT = new THREE.WebGLRenderTarget(1024, 512, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      colorSpace: THREE.NoColorSpace,
    });
  }
  const material = nishitaScene.userData.material;
  const u = material.uniforms;
  const el = (params.sunElevation * Math.PI) / 180;
  const az = (params.sunRotation * Math.PI) / 180;
  u.sunPosition.value.set(
    Math.cos(el) * Math.cos(az),
    Math.sin(el),
    Math.cos(el) * Math.sin(az),
  );
  u.rayleigh.value = Math.max(0, params.air);
  u.mie.value = Math.max(0, params.dust);
  u.ozone.value = Math.max(0, params.ozone);
  u.altitude.value = Math.max(0, params.altitude);
  u.sunDisc.value = params.sunDisc ? 1 : 0;
  u.sunSize.value = Math.max(0.01, params.sunSize);
  u.sunStrength.value = Math.max(0, params.sunStrength);
  u.ms.value = params.ms ? 1 : 0;
  renderer.setRenderTarget(nishitaRT);
  renderer.render(nishitaScene, nishitaCam);
  renderer.setRenderTarget(null);
  const tex = nishitaRT.texture;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  // 线性 HDR 内容：色调映射/输出编码由 three 背景管线按渲染器设置统一处理
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  return tex;
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
