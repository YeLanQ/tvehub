// 自定义着色器材质（TSL / WebGPU 实现，播放器侧）——仅在网页运行时的渲染后端为
// WebGPU 时被 player 动态 import（本文件静态依赖 three 的 WebGPU 构建）。
//
// 与编辑器 src/framework/material/customNodeMaterial.ts 逐行对应；与 GLSL 版
// （mesh.mjs 内 createCustomMaterial）共享同一份程序/属性表（由 shaderlab.mjs
// 组装），故参数语义与渲染状态一致。
//
// 为什么单独一份实现：WebGPU 后端不认识 GLSL ShaderMaterial（WGSL 需要节点图）。
// 把组装好的 GLSL 顶点/片元经 glslToTsl.mjs 转译为 TSL 回调体，挂到 NodeMaterial
// 的 vertexNode / fragmentNode。TSL 命名空间由 three 的 WebGPU 构建导出（THREE.TSL）。
// 翻译失败（受控子集外语法）或程序缺失时回退洋红占位，渲染不中断。
import * as THREE from "./three.webgpu.min.js";
import { translateProgram } from "./glslToTsl.mjs";

/** 共享白色 1×1 空贴图（无贴图属性时的兜底采样，符合 GLSL “无贴图采样白”） */
let emptyTexture = null;
function emptyTextureValue() {
  if (!emptyTexture) {
    const data = new Uint8Array([255, 255, 255, 255]);
    const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    tex.needsUpdate = true;
    emptyTexture = tex;
  }
  return emptyTexture;
}

/** 属性值 → uniform 节点初值（与 mesh.mjs customUniformValue 同规则：
 * 颜色 sRGB hex → 线性 Vector4；向量 → Vector4；数值 → number；贴图 → 空白纹理） */
function uniformInitialValue(prop, props) {
  const raw = props[prop.key];
  const value = raw === undefined ? prop.default : raw;
  switch (prop.kind) {
    case "color": {
      const hex = typeof value === "number" ? value : parseInt(String(value).replace("#", ""), 16);
      const c = new THREE.Color().setHex(Number.isFinite(hex) ? hex & 0xffffff : 0xffffff);
      return new THREE.Vector4(c.r, c.g, c.b, 1);
    }
    case "vector": {
      const a = Array.isArray(value) ? value : [0, 0, 0, 0];
      return new THREE.Vector4(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0);
    }
    case "texture":
      return emptyTextureValue();
    case "int":
      return Math.round(typeof value === "number" ? value : 0);
    default:
      return typeof value === "number" ? value : 0;
  }
}

/** 在册 TSL 自定义材质（每帧推进 _Time；材质释放时自动出册） */
const live = new Set();

/**
 * 创建 TSL 自定义材质工厂（WebGPU 后端）。构建不含 TSL 命名空间或 NodeMaterial
 * 时返回 null，调用方回退 GLSL 材质并告警。返回 { create(m), tick(seconds) }。
 */
export function createNodeCustomMaterialFactory() {
  const tsl = THREE.TSL;
  if (!tsl || typeof tsl.uniform !== "function") return null;
  if (typeof THREE.NodeMaterial !== "function") return null;

  return {
    /** 由 mesh.mjs createCustomMaterial 委托：m = { program, properties, props } */
    create(m) {
      const program = m.program ?? null;
      const properties = m.properties ?? [];
      const props = m.props || {};

      const material = new THREE.NodeMaterial();
      material.name = "CustomNodeMaterial";
      material.userData.__tveCustomTsl = true;
      material.userData.customProperties = properties;

      // uniform 节点（_Time + 每属性）；挂 material.uniforms 兼容 textures.mjs 回填
      const uniforms = {};
      uniforms._Time = tsl.uniform(0);
      for (const prop of properties) uniforms[prop.key] = tsl.uniform(uniformInitialValue(prop, props));
      material.userData.customUniforms = uniforms;
      material.uniforms = uniforms;

      if (program) {
        const result = translateProgram({
          vertex: program.vertex,
          fragment: program.fragment,
          tsl,
          uniforms,
          timeNode: uniforms._Time,
        });
        if (result.error || !result.vertexNode || !result.fragmentNode) {
          applyPlaceholder(material, tsl);
        } else {
          material.vertexNode = result.vertexNode;
          material.fragmentNode = result.fragmentNode;
        }
      } else {
        applyPlaceholder(material, tsl);
      }

      material.transparent = program ? program.transparent === true : false;
      material.depthWrite = program ? program.depthWrite !== false : true;
      material.side = !program
        ? THREE.FrontSide
        : program.side === "double"
          ? THREE.DoubleSide
          : program.side === "back"
            ? THREE.BackSide
            : THREE.FrontSide;
      material.needsUpdate = true;

      live.add(material);
      material.addEventListener("dispose", () => live.delete(material));
      return material;
    },
    /** 渲染循环推进：设置全部在册材质的 _Time（秒） */
    tick(seconds) {
      if (live.size === 0) return;
      for (const mat of live) {
        const t = mat.userData.customUniforms?._Time;
        if (t) t.value = seconds;
      }
    },
  };
}

/** 占位：洋红片元（顶点用默认内置变换）——一眼可见的“着色器不可用”信号 */
function applyPlaceholder(material, tsl) {
  material.vertexNode = null;
  material.fragmentNode = tsl.Fn(() => tsl.vec4(1, 0, 1, 1))();
}