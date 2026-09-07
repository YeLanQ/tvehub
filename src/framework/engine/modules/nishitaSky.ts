// nishitaSky —— Blender「天空纹理」风格程序化天空（Nishita/Preetham 大气散射）：
// 以全屏三角形 + 散射片元着色器渲染等距柱状全景到 RT 纹理，参数对齐 Blender：
// 日轮/太阳尺寸/太阳强度/太阳高度/太阳旋转/海拔/空气/气溶胶/臭氧/多重散射。
// 散射数学移植自 three/examples/jsm/objects/Sky.js（MIT），并扩展：
// 太阳尺寸可调、臭氧吸收、海拔密度衰减、多重散射近似。
// 生成的纹理为线性 HDR（HalfFloat），作为 EquirectangularReflectionMapping 背景。
import * as THREE from "three";

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
  /** 空气密度（瑞利散射倍率） */
  air: number;
  /** 气溶胶密度（米氏散射倍率） */
  dust: number;
  /** 臭氧密度（吸收倍率） */
  ozone: number;
  /** 多重散射（近似环境补光） */
  ms: boolean;
}

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform vec3 sunPosition;
  uniform float rayleigh;   // 空气
  uniform float mie;        // 气溶胶
  uniform float ozone;      // 臭氧
  uniform float altitude;   // 海拔（米）
  uniform float mieDirectionalG;
  uniform float sunDisc;     // 日轮开关
  uniform float sunSize;     // 太阳全角尺寸（度）
  uniform float sunStrength; // 太阳强度
  uniform float ms;          // 多重散射
  uniform vec3 up;

  const float e = 2.718281828459045;
  const float pi = 3.141592653589793;
  const vec3 lambda = vec3(680E-9, 550E-9, 450E-9);
  const vec3 totalRayleigh = vec3(5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5);
  const float vSun = 4.0;
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
    // 等距柱状 UV → 方向（与 three equirectUv 采样约定一致：v=1 天顶）
    float phi = (vUv.x - 0.5) * 2.0 * pi;
    float sy = sin((vUv.y - 0.5) * pi);
    float sr = sqrt(max(0.0, 1.0 - sy * sy));
    vec3 direction = normalize(vec3(sr * cos(phi), sy, sr * sin(phi)));
    vec3 sunDir = normalize(sunPosition);

    // 海拔 → 大气密度指数衰减
    float density = exp(-max(altitude, 0.0) / 8500.0);

    float upDot = dot(up, direction);
    // 地平线以下：镜像气团（继续的大气路径）+ 朝天底渐进加深（地球阴影）
    float below = smoothstep(0.0, 0.35, -upDot);
    float airmassUpDot = mix(upDot, abs(upDot), below);

    float sunfade = 1.0 - clamp(1.0 - exp((sunPosition.y / 450000.0)), 0.0, 1.0);
    float rayleighCoefficient = rayleigh * density - (1.0 * (1.0 - sunfade));
    vec3 betaR = totalRayleigh * max(rayleighCoefficient, 0.0);
    vec3 betaM = totalMie(2.0) * mie * density;

    // 光学厚度
    float zenithAngle = acos(clamp(airmassUpDot, -1.0, 1.0));
    float inverse = 1.0 / (cos(zenithAngle) + 0.15 * pow(93.885 - ((zenithAngle * 180.0) / pi), -1.253));
    float sR = rayleighZenithLength * inverse;
    float sM = mieZenithLength * inverse;
    vec3 Fex = exp(-(betaR * sR + betaM * sM));
    // 臭氧吸收（Chappuis 带近似，蓝端弱/绿端强 → 天空更蓝、日落更橙）
    vec3 betaOz = ozone * vec3(0.650, 1.881, 0.085) * 2.5E-5;
    Fex *= exp(-betaOz * sR * 0.35);

    float cosTheta = dot(direction, sunDir);
    vec3 betaRTheta = betaR * rayleighPhase(cosTheta * 0.5 + 0.5);
    vec3 betaMTheta = betaM * hgPhase(cosTheta, mieDirectionalG);

    float sunE = sunIntensity(dot(sunDir, up));
    vec3 Lin = pow(sunE * ((betaRTheta + betaMTheta) / (betaR + betaM)) * (1.0 - Fex), vec3(1.5));
    Lin *= mix(vec3(1.0), pow(sunE * ((betaRTheta + betaMTheta) / (betaR + betaM)) * Fex, vec3(1.0 / 2.0)), clamp(pow(1.0 - dot(up, sunDir), 5.0), 0.0, 1.0));
    // 地平线下朝天底逐渐加深（暖色余辉 → 暗红棕）
    Lin *= mix(1.0, 0.22, below);

    vec3 L0 = vec3(0.1) * Fex;
    // 太阳圆盘：尺寸可调 + 随尺寸成比例的软边缘（半影）
    float halfSin = sin(radians(max(sunSize, 0.01)) * 0.5);
    float sunCos = cos(radians(max(sunSize, 0.01)) * 0.5);
    float sundisc = smoothstep(sunCos, sunCos + max(0.0001, halfSin * 0.12), cosTheta) * sunDisc;
    L0 += (sunE * 19000.0 * Fex * sunStrength) * sundisc;

    vec3 texColor = (Lin + L0) * 0.04 + vec3(0.0, 0.0003, 0.00075);
    // 多重散射近似：保留散射消光的低强度环境补光
    texColor += ms * (1.0 - Fex) * 0.035 * vec3(0.55, 0.7, 1.0) * (sunE / EE);
    // 输出线性 HDR：色调映射交给渲染端（ldr 直出 sRGB 编码，hdr 走 ACES），
    // 保证视口/预览/运行时各消费端按同一渲染器设置得到一致结果
    gl_FragColor = vec4(texColor, 1.0);
  }
`;

let genMaterial: THREE.ShaderMaterial | null = null;
let genScene: THREE.Scene | null = null;
let genRenderTarget: THREE.WebGLRenderTarget | null = null;
let genCamera: THREE.Camera | null = null;
const GEN_W = 1024;
const GEN_H = 512;

function ensureGenerator(): void {
  if (genMaterial) return;
  genScene = new THREE.Scene();
  genCamera = new THREE.Camera();
  genCamera.projectionMatrix.identity();
  genMaterial = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
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
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
  );
  geometry.setAttribute(
    "uv",
    new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2),
  );
  genScene.add(new THREE.Mesh(geometry, genMaterial));
  genRenderTarget = new THREE.WebGLRenderTarget(GEN_W, GEN_H, {
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
 * 必须传入最终消费该纹理的渲染器（RT 纹理是 GPU 资源，跨上下文不可用）；
 * 返回的纹理由生成器持有（单例 RT），调用方不得 dispose。
 * WebGPU 等不支持 GLSL 离屏渲染的后端会抛错/失败，由调用方回退渐变兜底。
 */
export function buildNishitaSkyEquirect(
  renderer: THREE.WebGLRenderer,
  params: NishitaSkyParams,
): THREE.Texture {
  ensureGenerator();
  const u = genMaterial!.uniforms;
  const scene = genScene!;
  const camera = genCamera!;
  const target = genRenderTarget!;
  const el = THREE.MathUtils.degToRad(params.sunElevation);
  const az = THREE.MathUtils.degToRad(params.sunRotation);
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

  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  const tex = target.texture;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  // 线性 HDR 内容：按线性采样，色调映射/输出编码由 three 背景管线按渲染器设置统一处理
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  return tex;
}
