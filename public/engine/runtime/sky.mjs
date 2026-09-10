// 程序化/三段式天空盒：与编辑器 framework/engine/modules/skyboxTextures.ts 按同
// 一算法复刻，保证网页预览与编辑器视口表现一致。
import * as THREE from "../core/three.module.min.js";
import { num, matColor } from "../core/utils.mjs";

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

/** 天空着色器引用判定 → 天空材质种类（"procedural" / "cube"；非天空着色器返回 null）。
 * 与编辑器 framework/material/shader.ts 的 skyKindOfShaderRef 同规则：
 * 新格式按**文件名**精确匹配天空着色器资产（SkyProcedural.shader / SkyBox.shader），
 * 旧格式为魔法串；不能用「是不是 .shader 引用」之类的宽松条件，否则任何挂 .shader
 * 的普通材质（PBR/自定义…）都会被误判成天空材质。 */
function skyKindOfShaderRef(shader) {
  const ref = String(shader ?? "").trim();
  if (!ref) return null;
  if (ref === "SkyProcedural" || ref === "SkyBox") {
    return ref === "SkyProcedural" ? "procedural" : "cube";
  }
  const base = ref.split("/").pop() ?? ref;
  if (base === "SkyProcedural.shader") return "procedural";
  if (base === "SkyBox.shader") return "cube";
  return null;
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
    // 天空材质判别：kind 字段优先，否则要求 shader 引用天空着色器（旧格式为魔法串）
    const refKind = skyKindOfShaderRef(shader);
    const declaredKind = kind === "procedural" ? "procedural" : kind === "cube" ? "cube" : null;
    if (!declaredKind && !refKind) return null;
    const num = (v, f) => (typeof v === "number" && Number.isFinite(v) ? v : f);
    const bool = (v, f) => (typeof v === "boolean" ? v : f);
    const str = (v, f) => (typeof v === "string" ? v : f);
    return {
      kind: declaredKind ?? refKind,
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
// 透射率 LUT 预计算（cosθ/海拔）+ 沿视线 Hillaire 解析积分的多重散射，对齐 Blender
// sky_multiple_scattering：4 波长光谱解析拟合转 XYZ、平台高斯软边缘日轮（无硬边锯齿）、
// 命中地面的视线叠加 Lambert 地表辐亮度（海拔 0 时地平线以下不再全黑）。
const NISHITA_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// —— 两个 pass 共用的无状态部分：物理常量 + 密度函数 + 几何函数 ——
const SKY_COMMON = `
  const float PI = 3.141592653589793;

  // 地球/大气（km，Blender 约定）
  const float EARTH_RADIUS = 6371.0;
  const float ATMOSPHERE_THICKNESS = 100.0;
  const float ATMOSPHERE_RADIUS = 6471.0;

  // 地面反照率 / 各向同性相位 / 瑞利相位缩放
  const float GROUND_ALBEDO = 0.3;
  const float PHASE_ISOTROPIC = 0.0795774715459477;   // 1/(4π)
  const float RAYLEIGH_PHASE_SCALE = 0.0596831036595; // (3/16)·(1/π)

  // 气溶胶（米氏）各向异性
  const float G = 0.8;
  const float SQR_G = 0.64;

  // 4 波长光谱数据（630, 560, 490, 430 nm，城市区）
  const vec4 SUN_SPECTRAL_IRRADIANCE = vec4(1.679, 1.828, 1.986, 1.307);
  const vec4 MOLECULAR_SCATTERING_BASE = vec4(6.605e-3, 1.067e-2, 1.842e-2, 3.156e-2);
  const vec4 OZONE_ABSORPTION_CROSS = vec4(3.472e-25, 3.914e-25, 1.349e-25, 11.03e-27);
  const float OZONE_MEAN_DOBSON = 334.5;
  const vec4 AEROSOL_ABSORPTION_CROSS = vec4(2.8722e-24, 4.6168e-24, 7.9706e-24, 1.3578e-23);
  const vec4 AEROSOL_SCATTERING_CROSS = vec4(1.5908e-22, 1.7711e-22, 2.0942e-22, 2.4033e-22);
  const float AEROSOL_BASE_DENSITY = 1.3681e20;
  const float AEROSOL_BACKGROUND_DENSITY = 2.0e6;
  const float AEROSOL_HEIGHT_SCALE = 0.73;

  // 光谱 → XYZ（4 波长的解析拟合系数）
  const vec3 SPECTRAL_XYZ_0 = vec3(53.3869177386, 22.9813375067, 0.0);
  const vec3 SPECTRAL_XYZ_1 = vec3(43.9048444664, 71.3477957001, 0.102506867966);
  const vec3 SPECTRAL_XYZ_2 = vec3(1.61372782516, 18.4229605915, 31.7429211884);
  const vec3 SPECTRAL_XYZ_3 = vec3(20.7626686738, 2.36142135233, 110.480096433);

  // XYZ → 线性 sRGB（Rec.709）
  const mat3 XYZ_TO_RGB = mat3(
    3.2404542, -0.9692660, 0.0556434,
    -1.5371385, 1.8760108, -0.2040259,
    -0.4985314, 0.0415560, 1.0572252
  );

  // 高度 h (km) 处的分子散射系数（瑞利）
  vec4 molecular_scattering_coeff(float h) {
    return MOLECULAR_SCATTERING_BASE * exp(-0.07771971 * pow(h, 1.16364243));
  }

  // 高度 h (km) 处的臭氧分子吸收系数
  vec4 molecular_absorption_coeff(float h) {
    float lh = log(max(h, 1e-4));
    float density = 3.78547397e20 * exp(-(lh - 3.22261) * (lh - 3.22261) * 5.55555555 - lh);
    return OZONE_ABSORPTION_CROSS * (OZONE_MEAN_DOBSON * density);
  }

  // 高度 h (km) 处的气溶胶数密度
  float aerosol_density_fn(float h) {
    return AEROSOL_BASE_DENSITY * (exp(-h / AEROSOL_HEIGHT_SCALE) + AEROSOL_BACKGROUND_DENSITY / AEROSOL_BASE_DENSITY);
  }

  vec3 spectral_to_xyz(vec4 L) {
    return SPECTRAL_XYZ_0 * L.x + SPECTRAL_XYZ_1 * L.y + SPECTRAL_XYZ_2 * L.z + SPECTRAL_XYZ_3 * L.w;
  }

  // 由天顶角余弦构造方向（太阳在 xz 平面，+z 为天顶）
  vec3 sun_direction(float cos_theta) {
    return vec3(-sqrt(max(1.0 - cos_theta * cos_theta, 0.0)), 0.0, cos_theta);
  }

  // 射线与球求交（返回最近正交点距离，无交点返回 -1）
  float ray_sphere_intersection(vec3 pos, vec3 dir, float radius) {
    float b = dot(pos, dir);
    float c = dot(pos, pos) - radius * radius;
    if (c > 0.0 && b > 0.0) return -1.0;
    float d = b * b - c;
    if (d < 0.0) return -1.0;
    if (d >= b * b) return -b + sqrt(d);
    return -b - sqrt(d);
  }
`;

// —— Pass 1：透射率 LUT（256×64）——
// u = cosθ 映射到 [0,1]，v = 归一化海拔 [0,1]
const TRANSMITTANCE_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform float airDensity;
  uniform float aerosolDensity;
  uniform float ozoneDensity;

  const int TRANSMITTANCE_STEPS = 64;

  ${SKY_COMMON}

  void main() {
    float cosTheta = vUv.x * 2.0 - 1.0;
    float normAlt = vUv.y;
    vec3 sd = sun_direction(cosTheta);
    float dCenter = mix(EARTH_RADIUS, ATMOSPHERE_RADIUS, normAlt);
    vec3 ro = vec3(0.0, 0.0, dCenter);
    float tD = ray_sphere_intersection(ro, sd, ATMOSPHERE_RADIUS);
    float tStep = tD / float(TRANSMITTANCE_STEPS);
    vec4 result = vec4(0.0);
    for (int i = 0; i < TRANSMITTANCE_STEPS; i++) {
      float t = (float(i) + 0.5) * tStep;
      vec3 x_t = ro + sd * t;
      float alt = max(length(x_t) - EARTH_RADIUS, 0.0);
      float localAerosol = aerosol_density_fn(alt) * aerosolDensity;
      vec4 extinction = AEROSOL_ABSORPTION_CROSS * localAerosol
                      + AEROSOL_SCATTERING_CROSS * localAerosol
                      + molecular_absorption_coeff(alt) * ozoneDensity
                      + molecular_scattering_coeff(alt) * airDensity;
      result += extinction * tStep;
    }
    gl_FragColor = exp(-result);
  }
`;

// —— Pass 2：天空等距柱状全景 + 日轮 + 地面 ——
const SKY_FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform vec3 sunDir;             // z-up 太阳方向
  uniform float angularDiameter;   // 太阳全角（弧度）
  uniform float sunIntensity;      // 太阳强度（标量倍率）
  uniform float sunDisc;           // 日轮开关
  uniform float airDensity;
  uniform float aerosolDensity;
  uniform float ozoneDensity;
  uniform float altitudeKm;
  uniform float msOn;              // 多重散射开关
  uniform sampler2D transmittanceLUT;

  // —— 输出曝光（调参入口：整体亮度/显示映射）——
  // 物理 radiance 天顶约 1~6（Blender 交给视图变换处理），本管线 LDR 无色调映射直出，
  // 按旧实现的天顶线性亮度校准：0.05 → 常规蓝天观感
  const float SKY_EXPOSURE = 0.05;

  const int IN_SCATTERING_STEPS = 64;

  ${SKY_COMMON}

  vec4 lookup_transmittance(float cosTheta, float normAlt) {
    float u = clamp(cosTheta * 0.5 + 0.5, 0.0, 1.0);
    float v = clamp(normAlt, 0.0, 1.0);
    return texture2D(transmittanceLUT, vec2(u, v));
  }

  // 多重散射：地面反照率二阶散射 + 大气多散射解析拟合
  vec4 lookup_multiscattering(float cosTheta, float normAlt, float d) {
    float rDivD = EARTH_RADIUS / max(d, 1e-4);
    float omega = 2.0 * PI * (1.0 - sqrt(max(1.0 - rDivD * rDivD, 0.0)));
    vec4 T_to_ground = lookup_transmittance(cosTheta, 0.0);
    vec4 T_ground_to_sample = lookup_transmittance(1.0, 0.0) / lookup_transmittance(1.0, normAlt);
    vec4 L_ground = PHASE_ISOTROPIC * omega * (GROUND_ALBEDO / PI) * T_to_ground * T_ground_to_sample * cosTheta;
    vec4 L_ms = 0.02 * vec4(0.217, 0.347, 0.594, 1.0) / (1.0 + 5.0 * exp(-17.92 * cosTheta));
    return (msOn > 0.5) ? (L_ms + L_ground) : vec4(0.0);
  }

  vec4 get_inscattering(vec3 rd, vec3 ro, float tD) {
    float cosTheta = dot(-rd, sunDir);
    float molecularPhase = RAYLEIGH_PHASE_SCALE * (1.0 + cosTheta * cosTheta);
    float den = 1.0 + SQR_G + 2.0 * G * cosTheta;
    float aerosolPhase = (1.0 / (4.0 * PI)) * (1.0 - SQR_G) / (den * sqrt(den));

    float dt = tD / float(IN_SCATTERING_STEPS);
    vec4 L_inscattering = vec4(0.0);
    vec4 transmittance = vec4(1.0);
    for (int i = 0; i < IN_SCATTERING_STEPS; i++) {
      float t = (float(i) + 0.5) * dt;
      vec3 x_t = ro + rd * t;
      float dist = length(x_t);
      vec3 zenithDir = x_t / max(dist, 1e-4);
      float alt = max(dist - EARTH_RADIUS, 0.0);
      float normAlt = alt / ATMOSPHERE_THICKNESS;
      float sampleCosTheta = dot(zenithDir, sunDir);

      float localAerosol = aerosol_density_fn(alt) * aerosolDensity;
      vec4 aa = AEROSOL_ABSORPTION_CROSS * localAerosol;
      vec4 as_ = AEROSOL_SCATTERING_CROSS * localAerosol;
      vec4 ma = molecular_absorption_coeff(alt) * ozoneDensity;
      vec4 ms_ = molecular_scattering_coeff(alt) * airDensity;
      vec4 extinction = aa + as_ + ma + ms_;

      vec4 T_to_sun = lookup_transmittance(sampleCosTheta, normAlt);
      vec4 msMulti = lookup_multiscattering(sampleCosTheta, normAlt, dist);
      vec4 S = SUN_SPECTRAL_IRRADIANCE *
               (ms_ * (molecularPhase * T_to_sun + msMulti) +
                as_ * (aerosolPhase * T_to_sun + msMulti));

      vec4 stepT = exp(-dt * extinction);
      vec4 cutExt = max(extinction, vec4(1e-7));
      vec4 S_int = (S - S * stepT) / cutExt;
      L_inscattering += transmittance * S_int;
      transmittance *= stepT;
    }
    return L_inscattering;
  }

  void main() {
    // 等距柱状 UV → y-up 方向（与 three equirectUv 采样约定一致，v=1 天顶）
    float phi = (vUv.x - 0.5) * 2.0 * PI;
    float sy = sin((vUv.y - 0.5) * PI);
    float sr = sqrt(max(1.0 - sy * sy, 0.0));
    vec3 rdYup = vec3(sr * cos(phi), sy, sr * sin(phi));
    // y-up → z-up 轴映射（保持最终纹理方向语义不变）
    vec3 rd = vec3(rdYup.x, rdYup.z, rdYup.y);

    vec3 ro = vec3(0.0, 0.0, EARTH_RADIUS + altitudeKm);
    float atmosDist = ray_sphere_intersection(ro, rd, ATMOSPHERE_RADIUS);
    float groundDist = ray_sphere_intersection(ro, rd, EARTH_RADIUS);
    float tD = (groundDist < 0.0) ? atmosDist : groundDist;

    vec4 L4 = get_inscattering(rd, ro, tD);

    // —— 地面（命中地面时叠加 Lambertian 地表辐亮度，避免海拔 0 时地平线以下全黑）——
    // 直射日照（太阳透射 × 入射角）+ 多散射拟合项近似的环境光，再经视线段透射衰减；
    // 沿视线的空气透视（雾化）已由上面的散射路径积分给出。透射率 LUT 只覆盖向天顶的
    // 路径，向下的视线段用路径中点消光系数解析近似（海拔低时路径短，≈1）。
    if (groundDist >= 0.0) {
      vec3 xg = ro + rd * groundDist;
      vec3 n = xg / max(length(xg), 1e-4);
      float sunCosG = dot(n, sunDir);
      vec4 eGround = SUN_SPECTRAL_IRRADIANCE * lookup_transmittance(sunCosG, 0.0) * max(sunCosG, 0.0)
                   + PI * lookup_multiscattering(sunCosG, 0.0, EARTH_RADIUS);
      vec3 xMid = ro + rd * (groundDist * 0.5);
      float altMid = max(length(xMid) - EARTH_RADIUS, 0.0);
      float laMid = aerosol_density_fn(altMid) * aerosolDensity;
      vec4 extMid = AEROSOL_ABSORPTION_CROSS * laMid + AEROSOL_SCATTERING_CROSS * laMid
                  + molecular_absorption_coeff(altMid) * ozoneDensity
                  + molecular_scattering_coeff(altMid) * airDensity;
      L4 += (GROUND_ALBEDO / PI) * eGround * exp(-extMid * groundDist);
    }

    vec3 sky = XYZ_TO_RGB * spectral_to_xyz(L4);
    sky = max(sky, vec3(0.0));

    // —— 太阳圆盘（软边缘光晕：整盘平台高斯衰减，无硬边界，天然无锯齿）——
    if (sunDisc > 0.5) {
      float sunAngle = acos(clamp(dot(rd, sunDir), -1.0, 1.0));
      float halfAngular = angularDiameter * 0.5;
      float dirElevation = asin(clamp(rd.z, -1.0, 1.0));
      float earthIntersectionAngle = PI * 0.5 - asin(EARTH_RADIUS / (EARTH_RADIUS + altitudeKm));
      if (dirElevation > earthIntersectionAngle) {
        float t = sunAngle / max(halfAngular, 1e-5);
        // 平台高斯：t≤0.5 全亮（视觉尺寸 ≈ 标称尺寸），之后平滑衰减、~1.5R 处 <0.3% 截断。
        float tc = max(t - 0.5, 0.0);
        float edge = exp(-6.0 * tc * tc);
        if (edge > 0.003) {
          float limbDarkening = 1.0 - 0.6 * (1.0 - sqrt(1.0 - min(t, 1.0) * min(t, 1.0)));
          float solidAngle = 2.0 * PI * (1.0 - cos(halfAngular));
          float normAlt = clamp(altitudeKm / ATMOSPHERE_THICKNESS, 0.0, 1.0);
          vec4 sunTrans = lookup_transmittance(sunDir.z, normAlt);
          vec4 sunSpectrum = SUN_SPECTRAL_IRRADIANCE * sunTrans / solidAngle;
          vec3 sunColor = XYZ_TO_RGB * spectral_to_xyz(sunSpectrum);
          sky += max(sunColor, vec3(0.0)) * (sunIntensity * limbDarkening * edge);
        }
      }
    }

    gl_FragColor = vec4(sky * SKY_EXPOSURE, 1.0);
  }
`;

const LUT_W = 256;
const LUT_H = 64;
const SKY_W = 512;
const SKY_H = 256;

let nishitaRes = null;

function ensureNishita() {
  if (nishitaRes) return nishitaRes;
  const cam = new THREE.Camera();
  cam.projectionMatrix.identity();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
  );
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));

  const transmittanceMaterial = new THREE.ShaderMaterial({
    vertexShader: NISHITA_VERT,
    fragmentShader: TRANSMITTANCE_FRAG,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      airDensity: { value: 1 },
      aerosolDensity: { value: 1 },
      ozoneDensity: { value: 1 },
    },
  });
  const transmittanceScene = new THREE.Scene();
  transmittanceScene.add(new THREE.Mesh(geometry, transmittanceMaterial));
  const transmittanceRT = new THREE.WebGLRenderTarget(LUT_W, LUT_H, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    colorSpace: THREE.NoColorSpace,
  });

  const skyMaterial = new THREE.ShaderMaterial({
    vertexShader: NISHITA_VERT,
    fragmentShader: SKY_FRAG,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      sunDir: { value: new THREE.Vector3(0, 0, 1) },
      angularDiameter: { value: (0.545 * Math.PI) / 180 },
      sunIntensity: { value: 1 },
      sunDisc: { value: 1 },
      airDensity: { value: 1 },
      aerosolDensity: { value: 1 },
      ozoneDensity: { value: 1 },
      altitudeKm: { value: 0.1 },
      msOn: { value: 1 },
      transmittanceLUT: { value: transmittanceRT.texture },
    },
  });
  const skyScene = new THREE.Scene();
  skyScene.add(new THREE.Mesh(geometry, skyMaterial));
  const skyRT = new THREE.WebGLRenderTarget(SKY_W, SKY_H, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    colorSpace: THREE.NoColorSpace,
  });

  nishitaRes = {
    cam,
    transmittanceMaterial,
    transmittanceScene,
    transmittanceRT,
    skyMaterial,
    skyScene,
    skyRT,
  };
  return nishitaRes;
}

/** 按 Nishita 参数渲染等距柱状天空纹理（线性 HDR；参数结构与编辑器一致） */
export function makeNishitaSkyEquirect(renderer, params) {
  const res = ensureNishita();
  const el = (params.sunElevation * Math.PI) / 180;
  const az = (params.sunRotation * Math.PI) / 180;
  // z-up 太阳方向（z 为天顶），与 shader 内部 rd 的轴映射一致（sunDir 构造即 shader 约定，不再二次映射）
  const sunDir = new THREE.Vector3(
    Math.cos(el) * Math.cos(az),
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
  );
  const air = Math.max(0, params.air);
  const aerosol = Math.max(0, params.dust);
  const ozone = Math.max(0, params.ozone);
  const altitudeKm = Math.max(params.altitude, 1) / 1000; // 米 → km

  // Pass 1：透射率 LUT
  const tu = res.transmittanceMaterial.uniforms;
  tu.airDensity.value = air;
  tu.aerosolDensity.value = aerosol;
  tu.ozoneDensity.value = ozone;
  renderer.setRenderTarget(res.transmittanceRT);
  renderer.render(res.transmittanceScene, res.cam);

  // Pass 2：天空全景
  const su = res.skyMaterial.uniforms;
  su.sunDir.value.copy(sunDir);
  su.angularDiameter.value = (Math.max(0.01, params.sunSize) * Math.PI) / 180;
  su.sunIntensity.value = Math.max(0, params.sunStrength);
  su.sunDisc.value = params.sunDisc ? 1 : 0;
  su.airDensity.value = air;
  su.aerosolDensity.value = aerosol;
  su.ozoneDensity.value = ozone;
  su.altitudeKm.value = altitudeKm;
  su.msOn.value = params.ms ? 1 : 0;
  renderer.setRenderTarget(res.skyRT);
  renderer.render(res.skyScene, res.cam);

  renderer.setRenderTarget(null);
  const tex = res.skyRT.texture;
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
