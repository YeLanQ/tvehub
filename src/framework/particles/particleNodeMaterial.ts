// ---------------------------------------------------------------------------
// 粒子材质（TSL / WebGPU 实现）——仅在渲染后端为 WebGPU 时按需动态加载。
//
// 为什么单独一份实现：WebGPU 后端不认识 GLSL ShaderMaterial（WGSL 需要节点图）。
// 本实现用 three 的 **SpriteNodeMaterial**（其 setupPositionView 就是视空间 billboard，
// 与 GLSL 版同一算法）承载粒子：
//   positionNode = iPos（逐实例粒子中心，经 modelView 到视空间）
//   scaleNode    = 逐粒子世界尺寸（随寿命衰减，× 节点缩放由 SpriteNodeMaterial 自带）
//   colorNode    = 按 iT 的颜色渐变 + 末段淡出
//   map          = 精灵贴图（内置软圆点 / 用户贴图）
// 几何与逐实例属性布局与 GLSL 版完全一致（±0.5 四边形 + iPos/iT），
// 故两种后端下粒子外观与参数语义一致（含 gl_PointSize 上限不复存在这一点）。
//
// 注：不自己写 vertexNode —— three 的 sprite 顶点路径已验证可在 WebGPU 下渲染，
// 手写 clip-space 覆盖（vertexNode）多一条自维护路径，出错面更大。
//
// TSL 运行时接口按需做**最小结构声明**：@types/three 0.185 的 three/tsl 类型不完整
// （例如 projectionMatrix 实际导出名为 cameraProjectionMatrix），最小接口 + 断言
// 可避免被类型定义的不完整绑住手脚。
// ---------------------------------------------------------------------------
import * as THREE from "three";
import {
  FADE_OUT_FRACTION,
  getParticleSpriteTexture,
  type ParticleMaterial,
  type ParticleMaterialFactory,
} from "./particleMaterial";
import type { ParticleSystemSettings } from "./types";
import { cloneParticleSystemSettings } from "./types";

/** TSL 节点（结构类型：只用到 value 读写与链式运算） */
interface TslNode {
  value: unknown;
  readonly x: TslNode;
  readonly y: TslNode;
  readonly z: TslNode;
  add(other: unknown): TslNode;
  mul(other: unknown): TslNode;
  div(other: unknown): TslNode;
}

/** three/tsl 的最小接口（只声明本模块用到的函数与节点） */
interface TslLib {
  attribute(name: string, type?: string): TslNode;
  uniform(value: unknown): TslNode;
  float(value: number): TslNode;
  vec4(x: unknown, y: unknown, z: unknown, w: unknown): TslNode;
  mix(a: unknown, b: unknown, t: unknown): TslNode;
  clamp(x: unknown, lo: unknown, hi: unknown): TslNode;
  min(a: unknown, b: unknown): TslNode;
  oneMinus(x: unknown): TslNode;
}

/** 节点材质（结构类型：与 THREE.Material 同源，仅多出节点槽位） */
interface NodeMaterialLike extends THREE.Material {
  positionNode: TslNode | null;
  scaleNode: TslNode | null;
  colorNode: TslNode | null;
  map: THREE.Texture | null;
  sizeAttenuation: boolean;
  transparent: boolean;
  depthWrite: boolean;
  blending: THREE.Blending;
}

/** sRGB hex → 线性空间的 vec3 分量（与 GLSL 版 THREE.Color 的转换一致） */
function linearComponents(hex: number): [number, number, number] {
  const c = new THREE.Color().setHex(hex & 0xffffff);
  return [c.r, c.g, c.b];
}

class NodeParticleMaterial implements ParticleMaterial {
  readonly material: NodeMaterialLike;
  private readonly uStartColor: TslNode;
  private readonly uEndColor: TslNode;
  private readonly uStartSize: TslNode;
  private readonly uColorOver: TslNode;
  private readonly uSizeOver: TslNode;
  private readonly sprite: THREE.Texture;

  constructor(
    tsl: TslLib,
    SpriteMaterialCtor: new (params?: unknown) => NodeMaterialLike,
    settings: ParticleSystemSettings,
    sprite: THREE.Texture,
  ) {
    this.sprite = sprite;
    this.uStartColor = tsl.uniform(new THREE.Vector3());
    this.uEndColor = tsl.uniform(new THREE.Vector3());
    this.uStartSize = tsl.uniform(settings.startSize);
    this.uColorOver = tsl.uniform(settings.colorOverLifetime ? 1 : 0);
    this.uSizeOver = tsl.uniform(settings.sizeOverLifetime ? 1 : 0);

    const mat = new SpriteMaterialCtor({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: settings.blending === "normal" ? THREE.NormalBlending : THREE.AdditiveBlending,
    });
    mat.name = "ParticleNodeMaterial";
    this.material = mat;
    mat.map = sprite;
    // 世界单位尺寸（不做"-z 补偿"）：缩放由 scaleNode 给出
    mat.sizeAttenuation = true;

    const iT = tsl.attribute("iT", "float");
    const t = tsl.clamp(iT, 0.0, 1.0);

    // —— 顶点：实例中心 + 逐粒子尺寸（billboard 展开由 SpriteNodeMaterial 完成）——
    mat.positionNode = tsl.attribute("iPos", "vec3");
    mat.scaleNode = tsl.mix(this.uStartSize, this.uStartSize.mul(tsl.oneMinus(t)), this.uSizeOver);

    // —— 颜色：渐变 + 末段淡出（与 GLSL 版同一公式）——
    const rgb = tsl.mix(
      this.uStartColor,
      tsl.mix(this.uStartColor, this.uEndColor, t),
      this.uColorOver,
    );
    const fade = tsl.min(tsl.float(1.0), tsl.oneMinus(t).div(FADE_OUT_FRACTION));
    const alpha = tsl.mix(tsl.float(1.0), fade, this.uColorOver);
    mat.colorNode = tsl.vec4(rgb.x, rgb.y, rgb.z, alpha);

    this.setSettings(settings);
  }

  setSettings(s: ParticleSystemSettings): void {
    const [sr, sg, sb] = linearComponents(s.startColor);
    const [er, eg, eb] = linearComponents(s.endColor);
    (this.uStartColor.value as THREE.Vector3).set(sr, sg, sb);
    (this.uEndColor.value as THREE.Vector3).set(er, eg, eb);
    this.uStartSize.value = s.startSize;
    this.uColorOver.value = s.colorOverLifetime ? 1 : 0;
    this.uSizeOver.value = s.sizeOverLifetime ? 1 : 0;
  }

  setTexture(tex: THREE.Texture | null): void {
    const next = tex ?? this.sprite;
    if (this.material.map === next) return;
    // 有无贴图切换会改变着色器定义（需重编）；换另一张贴图不必
    const redefine = (this.material.map === null) !== (next === null);
    this.material.map = next;
    if (redefine) this.material.needsUpdate = true;
  }

  dispose(): void {
    this.material.dispose();
  }
}

/**
 * 加载 TSL 粒子材质工厂（WebGPU 后端）：动态引入 three/webgpu 与 three/tsl，
 * 返回可同步调用的材质工厂。模块不可用时返回 null（调用方保持 GLSL 材质并告警）。
 */
export async function loadParticleNodeMaterialFactory(): Promise<ParticleMaterialFactory | null> {
  try {
    const [webgpu, tslMod] = await Promise.all([
      import("three/webgpu"),
      import("three/tsl"),
    ]);
    const SpriteMaterialCtor = (webgpu as unknown as { SpriteNodeMaterial?: unknown })
      .SpriteNodeMaterial;
    if (typeof SpriteMaterialCtor !== "function") return null;
    const tsl = tslMod as unknown as TslLib;
    const Ctor = SpriteMaterialCtor as new (params?: unknown) => NodeMaterialLike;
    return (settings: ParticleSystemSettings): ParticleMaterial => {
      const s = cloneParticleSystemSettings(settings);
      return new NodeParticleMaterial(tsl, Ctor, s, getParticleSpriteTexture());
    };
  } catch {
    return null;
  }
}
