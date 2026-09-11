// ---------------------------------------------------------------------------
// 自定义着色器（kind=custom）的 TSL / WebGPU 渲染后端。
//
// WebGPU 后端不认识 GLSL ShaderMaterial（WGSL 需要节点图），本实现把后端
// 组装好的 GLSL 顶点/片元程序经 tsl/glslToTsl 转译为 TSL 节点回调体，挂到
// three 的 NodeMaterial（vertexNode / fragmentNode），实现与 GLSL 版一致的
// 顶点变换、varying 传递与片元着色。
//
// 与粒子（particleNodeMaterial.ts）同一策略：
// - 动态 import three/webgpu（NodeMaterial）与 three/tsl（节点函数库），
//   WebGL 后端不加载；
// - 最小结构声明 + 断言，避免被 @types/three 不完整的 node 类型绑住；
// - uniform 节点按属性建立并长期复用（换值不换节点），_Time 由渲染循环推进。
//
// 翻译失败（受控子集外语法）或程序缺失时回退洋红占位，渲染不中断。
// ---------------------------------------------------------------------------

import * as THREE from "three";
import type { MaterialParams } from "./types";
import { parseColorHex } from "./types";
import type { CustomBackend, CustomTextureLoader } from "./customBackend";
import type { CustomShaderProgram, ShaderPropertyDef } from "./shader";
import { translateProgram, type TslFnLib, type TslNode } from "./tsl";
import { TIME_UNIFORM, customPropValue, programSide, programSignature } from "./customShader";

/** NodeMaterial 的最小结构（node 槽位 + userData 缓存） */
interface NodeMaterialLike extends THREE.Material {
  vertexNode: TslNode | null;
  fragmentNode: TslNode | null;
  userData: Record<string, unknown>;
}

let emptyTexture: THREE.Texture | null = null;
/** 共享白色 1×1 空贴图（无贴图属性时的兜底采样，符合 GLSL “无贴图采样白”） */
function emptyTextureValue(): THREE.Texture {
  if (!emptyTexture) {
    const data = new Uint8Array([255, 255, 255, 255]);
    const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    tex.needsUpdate = true;
    emptyTexture = tex;
  }
  return emptyTexture;
}

/** 属性种类 → 初始 uniform 节点 */
function uniformNodeFor(tsl: TslFnLib, prop: ShaderPropertyDef): TslNode {
  switch (prop.kind) {
    case "color":
    case "vector":
      return tsl.uniform(new THREE.Vector4(1, 1, 1, 1));
    case "texture":
      return tsl.uniform(emptyTextureValue());
    default:
      return tsl.uniform(prop.kind === "int" ? 0 : 0);
  }
}

/** 颜色属性值 → linear 分量写入目标 Vector4 */
function writeColor(target: THREE.Vector4, hex: number): void {
  const c = new THREE.Color().setHex(hex & 0xffffff);
  target.set(c.r, c.g, c.b, 1);
}

class TslCustomBackend implements CustomBackend {
  private readonly NodeMaterialCtor: new () => NodeMaterialLike;
  private readonly tsl: TslFnLib;
  private readonly live = new Set<NodeMaterialLike>();

  constructor(NodeMaterialCtor: new () => NodeMaterialLike, tsl: TslFnLib) {
    this.NodeMaterialCtor = NodeMaterialCtor;
    this.tsl = tsl;
  }

  create(): THREE.Material {
    const m = new this.NodeMaterialCtor();
    m.userData.__tveCustomTsl = true;
    this.live.add(m);
    m.addEventListener("dispose", () => this.live.delete(m));
    return m;
  }

  matches(mat: THREE.Material): boolean {
    return (
      mat instanceof this.NodeMaterialCtor &&
      (mat as NodeMaterialLike).userData.__tveCustomTsl === true
    );
  }

  apply(
    mat: THREE.Material,
    params: MaterialParams,
    loader?: CustomTextureLoader,
    ctx?: { program?: CustomShaderProgram | null; properties?: ShaderPropertyDef[] },
  ): void {
    const m = mat as NodeMaterialLike;
    const program = ctx?.program ?? null;
    const properties = ctx?.properties ?? [];
    this.applyProgram(m, program, properties);
    const uniforms = this.ensureUniforms(m, properties);
    this.applyUniforms(uniforms, properties, params);
    this.applyTextures(uniforms, properties, params, loader);
  }

  tickTime(seconds: number): void {
    if (this.live.size === 0) return;
    for (const m of this.live) {
      const uniforms = m.userData.__customUniforms as Record<string, TslNode> | undefined;
      const t = uniforms?.[TIME_UNIFORM];
      if (t) t.value = seconds;
    }
  }

  // ---- 程序 → 节点图 ----

  private applyProgram(
    m: NodeMaterialLike,
    program: CustomShaderProgram | null,
    properties: ShaderPropertyDef[],
  ): void {
    const sig = programSignature(program);
    if (m.userData.__customProgramSig !== sig) {
      m.userData.__customProgramSig = sig;
      if (!program) {
        this.applyPlaceholder(m);
      } else {
        const uniforms = this.ensureUniforms(m, properties);
        const result = translateProgram({
          vertex: program.vertex,
          fragment: program.fragment,
          tsl: this.tsl,
          uniforms,
          timeNode: uniforms[TIME_UNIFORM],
        });
        if (result.error || !result.vertexNode || !result.fragmentNode) {
          this.applyPlaceholder(m);
        } else {
          m.vertexNode = result.vertexNode;
          m.fragmentNode = result.fragmentNode;
          m.needsUpdate = true;
        }
      }
    }
    m.transparent = program?.state.transparent ?? false;
    m.depthWrite = program?.state.depthWrite ?? true;
    m.side = programSide(program);
  }

  /** 占位：洋红片元（顶点用默认内置变换）——一眼可见的“着色器不可用”信号 */
  private applyPlaceholder(m: NodeMaterialLike): void {
    m.vertexNode = null;
    m.fragmentNode = this.tsl.Fn(() => this.tsl.vec4(1, 0, 1, 1))();
    m.needsUpdate = true;
  }

  // ---- uniform ----

  private ensureUniforms(
    m: NodeMaterialLike,
    properties: ShaderPropertyDef[],
  ): Record<string, TslNode> {
    let map = m.userData.__customUniforms as Record<string, TslNode> | undefined;
    if (!map) {
      map = {};
      m.userData.__customUniforms = map;
    }
    for (const prop of properties) {
      if (!map[prop.key]) map[prop.key] = uniformNodeFor(this.tsl, prop);
    }
    if (!map[TIME_UNIFORM]) map[TIME_UNIFORM] = this.tsl.uniform(0);
    return map;
  }

  private applyUniforms(
    uniforms: Record<string, TslNode>,
    properties: ShaderPropertyDef[],
    params: MaterialParams,
  ): void {
    for (const prop of properties) {
      const node = uniforms[prop.key];
      if (!node) continue;
      const v = customPropValue(prop, params.props);
      switch (prop.kind) {
        case "color":
          writeColor(node.value as THREE.Vector4, parseColorHex(v, 0xffffff));
          break;
        case "vector": {
          const a = Array.isArray(v) ? (v as number[]) : [0, 0, 0, 0];
          (node.value as THREE.Vector4).set(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0);
          break;
        }
        case "int":
          node.value = Math.round(typeof v === "number" ? v : 0);
          break;
        default:
          node.value = typeof v === "number" ? v : 0;
      }
    }
  }

  private applyTextures(
    uniforms: Record<string, TslNode>,
    properties: ShaderPropertyDef[],
    params: MaterialParams,
    loader?: CustomTextureLoader,
  ): void {
    for (const prop of properties) {
      if (prop.kind !== "texture") continue;
      const node = uniforms[prop.key];
      if (!node) continue;
      const rel = customPropValue(prop, params.props);
      if (typeof rel === "string" && rel !== "" && loader?.loadTexture) {
        void loader.loadTexture(rel, true).then((tex) => {
          node.value = tex ?? emptyTextureValue();
        });
      } else {
        node.value = emptyTextureValue();
      }
    }
  }
}

/**
 * 加载 TSL 自定义材质后端（WebGPU 后端）：动态引入 three/webgpu 与 three/tsl。
 * 模块不可用时返回 null（调用方保持 GLSL 后端并告警）。
 */
export async function loadTslCustomBackend(): Promise<CustomBackend | null> {
  try {
    const [webgpu, tslMod] = await Promise.all([
      import("three/webgpu"),
      import("three/tsl"),
    ]);
    const NodeMaterialCtor = (webgpu as unknown as { NodeMaterial?: unknown }).NodeMaterial;
    if (typeof NodeMaterialCtor !== "function") return null;
    const tsl = tslMod as unknown as TslFnLib;
    return new TslCustomBackend(NodeMaterialCtor as new () => NodeMaterialLike, tsl);
  } catch {
    return null;
  }
}