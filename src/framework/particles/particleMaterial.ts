// ---------------------------------------------------------------------------
// 粒子材质（GLSL / 经典 WebGLRenderer 实现）。
//
// 几何约定：实例化四边形 —— 基础几何为 ±0.5 的单位四边形（position/uv/index），
// 逐实例属性只有 iPos（粒子中心）+ iT（归一化寿命）。顶点着色器把四边形中心变换到
// 视空间后在 **视空间 XY 平面** 展开（billboard）：无论透视/正交、无需点尺寸换算，
// 也不受 GPU 点尺寸上限（gl_PointSize 上限）裁剪——这是选四边形而非点图元的原因，
// 也是 WebGPU 后端唯一可行的方案（其原生点图元固定 1 像素）。
//
// 逐粒子数据只上传 iPos(3) + iT(1) = 4 floats：颜色渐变/淡出/尺寸衰减全部由
// uStartColor/uEndColor/uStartSize + 开关 uniform 在顶点着色器内插值完成。
// 与播放器镜像 public/engine/core/particles.mjs 保持同一语义。
// ---------------------------------------------------------------------------
import * as THREE from "three";
import { cloneParticleSystemSettings, type ParticleSystemSettings } from "./types";

/** 标准重力加速度（gravityModifier=1 时的加速度，世界单位/秒²） */
export const PARTICLE_GRAVITY = 9.81;
/** 颜色随寿命：末段淡出占寿命的比例 */
export const FADE_OUT_FRACTION = 0.4;
/** 精灵贴图边长（像素） */
const SPRITE_SIZE = 64;

let spriteTexture: THREE.DataTexture | null = null;

/**
 * 软圆点精灵贴图（程序化径向渐变，中心不透明 → 边缘平滑淡出）。
 * 用 DataTexture 数值生成而非 canvas：不依赖 DOM，headless 冒烟测试也能建出。
 * 全局共享一份（所有粒子材质同一贴图，换贴图只改材质 uniform）。
 */
export function getParticleSpriteTexture(): THREE.DataTexture {
  if (spriteTexture) return spriteTexture;
  const n = SPRITE_SIZE;
  const data = new Uint8Array(n * n * 4);
  const c = (n - 1) / 2;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (x - c) / c;
      const dy = (y - c) / c;
      const r = Math.min(1, Math.hypot(dx, dy));
      const t = 1 - r;
      const a = t * t * (3 - 2 * t);
      const i = (y * n + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  spriteTexture = tex;
  return tex;
}

/**
 * 顶点着色器：视空间 billboard 展开 + 随寿命的颜色/尺寸插值。
 * - iPos 为粒子中心（模拟空间坐标，与节点本地坐标同坐标系的常规情形见 Emitter）；
 * - position.xy 是基础四边形角点（±0.5），乘 size 后即世界单位下的粒子尺寸；
 * - uColorOverLifetime/uSizeOverLifetime 用 float 开关（0/1）而非 bool：避免不同
 *   GLSL 版本对 bool uniform 的差异，且 mix 写法无分支。
 */
const VERTEX_SHADER = /* glsl */ `
  attribute vec3 iPos;
  attribute float iT;

  uniform vec3 uStartColor;
  uniform vec3 uEndColor;
  uniform float uStartSize;
  uniform float uColorOverLifetime;
  uniform float uSizeOverLifetime;

  varying vec4 vColor;
  varying vec2 vUv;

  void main() {
    float t = clamp( iT, 0.0, 1.0 );
    // 颜色随寿命：start → end 插值；关闭时恒为起始色
    vec3 rgb = mix( uStartColor, mix( uStartColor, uEndColor, t ), uColorOverLifetime );
    // 末段淡出：寿命最后 FADE_OUT_FRACTION 段线性淡到 0；关闭时不淡出
    float fade = min( 1.0, ( 1.0 - t ) / ${FADE_OUT_FRACTION.toFixed(2)} );
    vColor = vec4( rgb, mix( 1.0, fade, uColorOverLifetime ) );

    float size = mix( uStartSize, uStartSize * ( 1.0 - t ), uSizeOverLifetime );

    // 视空间展开：中心投影到视空间后，在视平面内偏移角点 → 恒朝相机（透视/正交通用）
    vec4 mv = modelViewMatrix * vec4( iPos, 1.0 );
    mv.xy += position.xy * size;
    vUv = uv;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uMap;

  varying vec4 vColor;
  varying vec2 vUv;

  void main() {
    vec4 texel = texture2D( uMap, vUv );
    float a = texel.a * vColor.a;
    if ( a <= 0.002 ) discard;
    // 贴图 RGB 与粒子颜色相乘（白底透明贴图即"着色精灵"；内置软圆点 RGB 为白）
    gl_FragColor = vec4( vColor.rgb * texel.rgb, a );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** 基础四边形（±0.5，UV 铺满）：作为实例化几何的共享形状，逐实例只有中心与寿命 */
export function createQuadGeometry(): THREE.InstancedBufferGeometry {
  const geom = new THREE.InstancedBufferGeometry();
  geom.setAttribute(
    "position",
    new THREE.BufferAttribute(
      new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
      3,
    ),
  );
  geom.setAttribute(
    "uv",
    new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2),
  );
  geom.setIndex([0, 1, 2, 0, 2, 3]);
  return geom;
}

/** 粒子材质句柄（后端无关接口：GLSL 与 TSL 两种实现，Emitter 只见这个面） */
export interface ParticleMaterial {
  readonly material: THREE.Material;
  /** 写入发射参数（颜色/尺寸/开关）；贴图另经 setTexture */
  setSettings(s: ParticleSystemSettings): void;
  /** 替换贴图（null = 内置程序化软圆点） */
  setTexture(tex: THREE.Texture | null): void;
  dispose(): void;
}

/** 粒子材质工厂（按渲染后端注入：经典 WebGL 用 GLSL，WebGPU 用 TSL） */
export type ParticleMaterialFactory = (settings: ParticleSystemSettings) => ParticleMaterial;

/** 混合模式 → three 混合常量 */
export function particleBlendingOf(s: ParticleSystemSettings): THREE.Blending {
  return s.blending === "normal" ? THREE.NormalBlending : THREE.AdditiveBlending;
}

class GlslParticleMaterial implements ParticleMaterial {
  readonly material: THREE.ShaderMaterial;

  constructor(settings: ParticleSystemSettings) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: getParticleSpriteTexture() },
        uStartColor: { value: new THREE.Color() },
        uEndColor: { value: new THREE.Color() },
        uStartSize: { value: settings.startSize },
        uColorOverLifetime: { value: settings.colorOverLifetime ? 1 : 0 },
        uSizeOverLifetime: { value: settings.sizeOverLifetime ? 1 : 0 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: particleBlendingOf(settings),
    });
    this.setSettings(settings);
  }

  setSettings(s: ParticleSystemSettings): void {
    const u = this.material.uniforms;
    // 颜色经 hex → 线性工作空间（与 PBR 管线一致；着色器末尾 colorspace_fragment 转回输出域）
    (u.uStartColor.value as THREE.Color).setHex(s.startColor & 0xffffff);
    (u.uEndColor.value as THREE.Color).setHex(s.endColor & 0xffffff);
    u.uStartSize.value = s.startSize;
    u.uColorOverLifetime.value = s.colorOverLifetime ? 1 : 0;
    u.uSizeOverLifetime.value = s.sizeOverLifetime ? 1 : 0;
  }

  setTexture(tex: THREE.Texture | null): void {
    const u = this.material.uniforms;
    const next = tex ?? getParticleSpriteTexture();
    if (u.uMap.value !== next) u.uMap.value = next;
  }

  dispose(): void {
    this.material.dispose();
  }
}

/** 创建 GLSL 粒子材质（经典 WebGLRenderer 后端；默认工厂） */
export function createGlslParticleMaterial(
  settings: ParticleSystemSettings,
): ParticleMaterial {
  return new GlslParticleMaterial(cloneParticleSystemSettings(settings));
}
