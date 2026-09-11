// 粒子材质（TSL / WebGPU 实现，播放器侧）——仅在网页运行时的渲染后端为
// WebGPU 时被 player 动态 import（本文件静态依赖 three 的 WebGPU 构建，
// 未被动态引入时不会进入页面加载）。
//
// 与编辑器 src/framework/particles/particleNodeMaterial.ts 逐行对应；
// 与 GLSL 版（particles.mjs 内 createGlslParticleMaterial）共享同一份几何与
// 逐实例属性布局（实例化四边形 + iPos/iT），故渲染外观与参数语义一致。
//
// 为什么单独一份实现：WebGPU 后端不认识 GLSL ShaderMaterial（WGSL 需要节点图）。
// 承载方式用 three 的 SpriteNodeMaterial —— 其 setupPositionView 就是视空间
// billboard，positionNode 取逐实例粒子中心、scaleNode 取逐粒子世界尺寸，
// 是 three 自身在 WebGPU 下渲染精灵的同一路径。
// TSL 命名空间由 three 的 WebGPU 构建导出（THREE.TSL），故不需要 three/tsl 那一份
// （它带裸导入，浏览器无打包器无法解析）。
import * as THREE from "./three.webgpu.min.js";
import { FADE_OUT_FRACTION, getParticleSpriteTexture } from "./particles.mjs";

/** sRGB hex → 线性空间的 vec3 分量（与 GLSL 版 THREE.Color 的转换一致） */
function linearComponents(hex) {
  const c = new THREE.Color().setHex(hex & 0xffffff);
  return [c.r, c.g, c.b];
}

class NodeParticleMaterial {
  constructor(tsl, settings) {
    this.tsl = tsl;
    this.sprite = getParticleSpriteTexture();
    this.currentTexture = this.sprite;

    this.uStartColor = tsl.uniform(new THREE.Vector3());
    this.uEndColor = tsl.uniform(new THREE.Vector3());
    this.uStartSize = tsl.uniform(settings.startSize);
    this.uColorOver = tsl.uniform(settings.colorOverLifetime ? 1 : 0);
    this.uSizeOver = tsl.uniform(settings.sizeOverLifetime ? 1 : 0);

    const material = new THREE.SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: settings.blending === "normal" ? THREE.NormalBlending : THREE.AdditiveBlending,
    });
    material.name = "ParticleNodeMaterial";
    material.map = this.sprite;
    // 世界单位尺寸（不做 "-z 补偿"）；缩放由 scaleNode 给出
    material.sizeAttenuation = true;
    this.material = material;

    const iT = tsl.attribute("iT", "float");
    const t = tsl.clamp(iT, 0.0, 1.0);

    // 顶点：实例中心 + 逐粒子尺寸（billboard 展开由 SpriteNodeMaterial 完成）
    material.positionNode = tsl.attribute("iPos", "vec3");
    material.scaleNode = tsl.mix(this.uStartSize, this.uStartSize.mul(tsl.oneMinus(t)), this.uSizeOver);

    // 颜色：渐变 + 末段淡出（与 GLSL 版同一公式）
    const rgb = tsl.mix(this.uStartColor, tsl.mix(this.uStartColor, this.uEndColor, t), this.uColorOver);
    const fade = tsl.min(tsl.float(1.0), tsl.oneMinus(t).div(FADE_OUT_FRACTION));
    const alpha = tsl.mix(tsl.float(1.0), fade, this.uColorOver);
    material.colorNode = tsl.vec4(rgb.x, rgb.y, rgb.z, alpha);

    this.setSettings(settings);
  }

  setSettings(s) {
    const [sr, sg, sb] = linearComponents(s.startColor);
    const [er, eg, eb] = linearComponents(s.endColor);
    this.uStartColor.value.set(sr, sg, sb);
    this.uEndColor.value.set(er, eg, eb);
    this.uStartSize.value = s.startSize;
    this.uColorOver.value = s.colorOverLifetime ? 1 : 0;
    this.uSizeOver.value = s.sizeOverLifetime ? 1 : 0;
  }

  setTexture(tex) {
    const next = tex ?? this.sprite;
    if (this.material.map === next) return;
    // 有无贴图切换会改变着色器定义（需重编）；换另一张贴图不必
    const redefine = (this.material.map === null) !== (next === null);
    this.material.map = next;
    this.currentTexture = next;
    if (redefine) this.material.needsUpdate = true;
  }

  dispose() {
    this.material.dispose();
  }
}

/**
 * 创建 TSL 粒子材质工厂（WebGPU 后端）。构建不含 TSL 命名空间或
 * SpriteNodeMaterial 时返回 null，调用方回退 GLSL 材质并告警。
 */
export function createNodeParticleMaterialFactory() {
  const tsl = THREE.TSL;
  if (!tsl || typeof tsl.attribute !== "function") return null;
  if (typeof THREE.SpriteNodeMaterial !== "function") return null;
  return (settings) => new NodeParticleMaterial(tsl, settings);
}
