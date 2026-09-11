// ---------------------------------------------------------------------------
// 自定义着色器（kind=custom）材质后端分派。
//
// 自定义着色器有两条渲染路径（对齐 particles 的“双实现 + 后端注入”模式）：
// - GLSL（默认，ShaderMaterial）：与既有实现一致，适合 WebGLRenderer；
// - TSL（WebGPU，NodeMaterial）：把 GLSL 程序转译为 TSL 节点图，见 customNodeMaterial.ts。
// 模块持有一个「当前后端」，默认 GLSL；编辑器在 WebGPU 后端挂载时经
// setCustomBackend 切到 TSL 实现。材质工厂（factory.ts）与渲染循环的
// _Time 推进都通过 getCustomBackend / tickCustomShaderTime 走后端无关入口。
// ---------------------------------------------------------------------------

import * as THREE from "three";
import type { MaterialParams } from "./types";
import {
  applyCustomProgram,
  applyCustomTextures,
  buildCustomUniforms,
  registerCustomMaterial,
  tickShaderTime,
} from "./customShader";
import type { CustomShaderProgram, ShaderPropertyDef } from "./shader";

/** 纹理异步装载器（结构兼容 MaterialTextureLoader，避免依赖 factory 造成循环） */
export interface CustomTextureLoader {
  loadTexture?(rel: string, srgb: boolean): Promise<THREE.Texture | null>;
}

/** 自定义着色器应用上下文（结构兼容 MaterialApplyContext） */
export interface CustomApplyContext {
  program?: CustomShaderProgram | null;
  properties?: ShaderPropertyDef[];
}

/** 自定义材质后端接口：创建 / 类型判定 / 参数与程序应用 / 时间推进 */
export interface CustomBackend {
  create(): THREE.Material;
  matches(mat: THREE.Material): boolean;
  apply(
    mat: THREE.Material,
    params: MaterialParams,
    loader?: CustomTextureLoader,
    ctx?: CustomApplyContext,
  ): void;
  tickTime(seconds: number): void;
}

/** GLSL 后端（默认）：three ShaderMaterial，复用既有 customShader 装配 */
const glslBackend: CustomBackend = {
  create: () => new THREE.ShaderMaterial({ uniforms: {} }),
  matches: (mat) => mat instanceof THREE.ShaderMaterial,
  apply(mat, params, loader, ctx) {
    const m = mat as THREE.ShaderMaterial;
    const program = ctx?.program ?? null;
    const properties = ctx?.properties ?? [];
    m.uniforms = buildCustomUniforms(properties, params, m.uniforms);
    applyCustomProgram(m, program);
    applyCustomTextures(properties, params, m.uniforms, loader);
    registerCustomMaterial(m);
  },
  tickTime(seconds) {
    tickShaderTime(seconds);
  },
};

let currentBackend: CustomBackend = glslBackend;

/** 切换自定义材质后端（null 恢复默认 GLSL） */
export function setCustomBackend(backend: CustomBackend | null): void {
  currentBackend = backend ?? glslBackend;
}

/** 当前自定义材质后端（材质工厂使用） */
export function getCustomBackend(): CustomBackend {
  return currentBackend;
}

/** 渲染循环推进：委托给当前后端的 _Time 处理 */
export function tickCustomShaderTime(seconds: number): void {
  currentBackend.tickTime(seconds);
}