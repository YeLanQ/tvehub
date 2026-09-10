// nishitaSky —— 程序化天空（Nishita 多重散射）：
// 算法沿用 Nishita 多重散射的开源实现
// （源自 Fernando García Liñán 硕士论文 "Physically Based Sky"）：
//   - 4 波长光谱（630/560/490/430nm）+ 解析拟合转 XYZ
//   - 透射率 LUT 预计算（256×64）：transmittance(cosθ, altitude)，散射时查表
//   - 多重散射为解析项：地面反照率二阶散射 + 大气多散射拟合（非迭代 pass）
//   - 单次散射沿视线 64 步 ray march，Hillaire 能量守恒解析积分
// 生成一张线性 HDR 等距柱状全景纹理（HalfFloat），作为 EquirectangularReflectionMapping 背景。
// 坐标约定：shader 内部为 z-up（算法原约定），外部 three 为 y-up，入口处做一次轴映射。
import * as THREE from "three";

// —— 生成器纹理尺寸（同时供 shader 插值使用：等距柱状图的像素角分辨率）——
const LUT_W = 256;
const LUT_H = 64;
const SKY_W = 1024;
const SKY_H = 512;

export interface NishitaSkyParams {
  /** 日轮（显示太阳圆盘） */
  sunDisc: boolean;
  /** 太阳尺寸（全角，度） */
  sunSize: number;
  /** 太阳强度（圆盘亮度倍率） */
  sunStrength: number;
  /** 太阳高度（度，0=地平线，90=天顶） */
  sunElevation: number;
  /** 太阳旋转（方位角，度；0 = +X） */
  sunRotation: number;
  /** 海拔（米） */
  altitude: number;
  /** 空气密度（瑞利/分子散射倍率） */
  air: number;
  /** 气溶胶密度（米氏散射倍率） */
  dust: number;
  /** 臭氧密度（吸收倍率） */
  ozone: number;
  /** 多重散射（是否启用多散射项） */
  ms: boolean;
}

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// —— 两个 pass 共用的无状态部分：物理常量 + 密度函数 + 几何函数 ——
const SKY_COMMON = /* glsl */ `
  const float PI = 3.141592653589793;

  // 地球/大气（km）
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
const TRANSMITTANCE_FRAG = /* glsl */ `
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

// —— Pass 2：天空等距柱状全景 + 日轮 ——
const SKY_FRAG = /* glsl */ `
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
  // 物理 radiance 天顶约 1~6（参考实现交给视图变换处理），本管线 LDR 无色调映射直出，
  // 按旧实现的天顶线性亮度（~0.15-0.3）校准：0.05 → sRGB 显示约 (56,78,110)~(86,112,151) 蓝天
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

    // —— 太阳圆盘（软边缘光晕：整盘高斯衰减，无硬边界，天然无锯齿）——
    // 屏幕空间采样锯齿；高斯软边缘视觉效果接近真实太阳的大气眩光。
    if (sunDisc > 0.5) {
      float sunAngle = acos(clamp(dot(rd, sunDir), -1.0, 1.0));
      float halfAngular = angularDiameter * 0.5;
      float dirElevation = asin(clamp(rd.z, -1.0, 1.0));
      float earthIntersectionAngle = PI * 0.5 - asin(EARTH_RADIUS / (EARTH_RADIUS + altitudeKm));
      if (dirElevation > earthIntersectionAngle) {
        float t = sunAngle / max(halfAngular, 1e-5);
        // 平台高斯：t≤0.5 全亮（视觉尺寸 ≈ 标称尺寸），之后平滑衰减、~1.5R 处 <0.3% 截断。
        // 注：纯高斯 exp(-4t²) 的半高点在 0.42R，小尺寸日轮的亮核缩水到亚像素而几乎不可见。
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

// —— 生成器单例（透射 LUT + 天空 RT 均为 GPU 资源，跨上下文不可用）——
let fullscreenGeometry: THREE.BufferGeometry | null = null;

let transmittanceMaterial: THREE.ShaderMaterial | null = null;
let transmittanceScene: THREE.Scene | null = null;
let transmittanceRT: THREE.WebGLRenderTarget | null = null;

let skyMaterial: THREE.ShaderMaterial | null = null;
let skyScene: THREE.Scene | null = null;
let skyRT: THREE.WebGLRenderTarget | null = null;

let genCamera: THREE.Camera | null = null;

function ensureGenerator(): void {
  if (transmittanceMaterial) return;

  genCamera = new THREE.Camera();
  genCamera.projectionMatrix.identity();

  fullscreenGeometry = new THREE.BufferGeometry();
  fullscreenGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
  );
  fullscreenGeometry.setAttribute(
    "uv",
    new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2),
  );

  // Pass 1：透射率 LUT
  transmittanceMaterial = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: TRANSMITTANCE_FRAG,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      airDensity: { value: 1 },
      aerosolDensity: { value: 1 },
      ozoneDensity: { value: 1 },
    },
  });
  transmittanceScene = new THREE.Scene();
  transmittanceScene.add(new THREE.Mesh(fullscreenGeometry, transmittanceMaterial));
  transmittanceRT = new THREE.WebGLRenderTarget(LUT_W, LUT_H, {
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

  // Pass 2：天空全景
  skyMaterial = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: SKY_FRAG,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      sunDir: { value: new THREE.Vector3(0, 0, 1) },
      angularDiameter: { value: THREE.MathUtils.degToRad(0.545) },
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
  skyScene = new THREE.Scene();
  skyScene.add(new THREE.Mesh(fullscreenGeometry, skyMaterial));
  skyRT = new THREE.WebGLRenderTarget(SKY_W, SKY_H, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    colorSpace: THREE.NoColorSpace,
  });
}

/**
 * 按 Nishita 参数把等距柱状天空全景渲染进指定 WebGL 渲染器（线性 HDR）。
 * 内部为两趟预计算：先算透射率 LUT，再采样 LUT 做多重散射积分并叠加日轮。
 * 必须传入最终消费该纹理的渲染器（RT 纹理是 GPU 资源，跨上下文不可用）；
 * 返回的纹理由生成器持有（单例 RT），调用方不得 dispose。
 * WebGPU 等不支持 GLSL 离屏渲染的后端会抛错/失败，由调用方回退渐变兜底。
 */
export function buildNishitaSkyEquirect(
  renderer: THREE.WebGLRenderer,
  params: NishitaSkyParams,
): THREE.Texture {
  ensureGenerator();

  const el = THREE.MathUtils.degToRad(params.sunElevation);
  const az = THREE.MathUtils.degToRad(params.sunRotation);
  // z-up 太阳方向（z 为天顶）
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
  const tu = transmittanceMaterial!.uniforms;
  tu.airDensity.value = air;
  tu.aerosolDensity.value = aerosol;
  tu.ozoneDensity.value = ozone;
  renderer.setRenderTarget(transmittanceRT);
  renderer.render(transmittanceScene!, genCamera!);

  // Pass 2：天空全景
  const su = skyMaterial!.uniforms;
  // sunDir 直接按 shader 内部 z-up 约定构造（z=天顶、方位角在 x-y 平面），
  // 与 rd 的轴映射 swap(rdYup) 恰好互为同一变换：swap(cos e·(cos a, sin a, 0) + sin e·ẑ) 即本向量。
  // 这里不能再做一次 swap（会把高度角和方位角互换，日轮位置与散射相位全错）。
  (su.sunDir.value as THREE.Vector3).copy(sunDir);
  su.angularDiameter.value = THREE.MathUtils.degToRad(Math.max(0.01, params.sunSize));
  su.sunIntensity.value = Math.max(0, params.sunStrength);
  su.sunDisc.value = params.sunDisc ? 1 : 0;
  su.airDensity.value = air;
  su.aerosolDensity.value = aerosol;
  su.ozoneDensity.value = ozone;
  su.altitudeKm.value = altitudeKm;
  su.msOn.value = params.ms ? 1 : 0;
  renderer.setRenderTarget(skyRT);
  renderer.render(skyScene!, genCamera!);

  renderer.setRenderTarget(null);

  const tex = skyRT!.texture;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  // 线性 HDR 内容：按线性采样，色调映射/输出编码由 three 背景管线按渲染器设置统一处理
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  return tex;
}
