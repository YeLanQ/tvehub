// ---------------------------------------------------------------------------
// 着色器 Hook 的 WebGPU（节点材质）后端：把同一份 Hook 片段翻译为 TSL 节点，
// 接到内置节点材质的端口槽位上，使 .shader 的效果在两种渲染后端下语义一致。
//
// 端口契约（与 GL 侧 shaderHooks.ts 的注入变量一一对应，只是实现载体不同）：
//   Vertex   → positionNode   端口变量 position（物体空间）
//   Diffuse  → colorNode      端口变量 diffuseColor（rgb = 基色 × 贴图，a = 不透明度）
//   Emissive → emissiveNode   端口变量 emissive（自发光叠加；与 GL 的 totalEmissiveRadiance 对应）
//   Normal   → normalNode     端口变量 normal（视空间法线；与 GL 的 normal 对应）
//   Fragment → GL 独有：节点路径下最终颜色由 three 内部合成，无法作为"当前值"喂给
//              Hook，故该端口在 WebGPU 下不生效（由上层显式提示，不静默失败）
//
// 只读环境变量（与 GL 的钩子变量同名同义）：
//   normal  → normalView（视空间法线；Vertex 端口下为 normalLocal 物体空间法线）
//   viewDir → positionView.negate().normalize()（视空间视线方向，与 GL 的 vViewPosition 一致）
//   uv      → uv()（纹理坐标属性，与 GL 的 uv 属性一致）
//   _Time   → 引擎注入的 uniform（秒）
// Properties 属性 → TSL uniform 节点（颜色/数值/向量/贴图，取值规则与 GL 侧一致）。
//
// three 的节点材质（MeshPhysicalNodeMaterial 等）自带经典材质属性（color/map/
// metalness/roughness/gradientMap…），所以分支配方参数仍由工厂的经典 apply 写入，
// 本模块只负责"接端口"。加载方式对齐粒子：WebGPU 未启用时不 import three/webgpu。
// ---------------------------------------------------------------------------

import * as THREE from "three";
import { parseColorHex } from "./types";
import type { ShaderHookData, ShaderProps, ShaderTextureLoader } from "./shaderHooks";
import { compileHookNode, TranslateError, type TslFnLib, type TslNode } from "./tsl";

/** 节点材质侧的端口定义 */
interface NodeHookPort {
  /** 端口变量名（与 GL 注入的变量名一致，Hook 代码不用改） */
  name: string;
  /** 端口初值节点（该分支下的"当前值"，Hook 修改的是它） */
  seed(tsl: TslFnLib, mat: THREE.Material): TslNode;
  /** 端口结果接回材质 */
  write(tsl: TslFnLib, mat: THREE.Material, node: TslNode): void;
  /** 该端口下可用的只读环境变量 */
  idents(tsl: TslFnLib): Record<string, TslNode>;
  /** 支持该端口的渲染分支 */
  kinds: string[];
}

/** 视空间视线方向（与 GL 侧 `normalize(vViewPosition)` 等价：-mvPosition 归一化） */
function viewDirNode(tsl: TslFnLib): TslNode {
  return tsl.positionView.negate().normalize();
}

/** 支持端口的渲染分支（与后端 shader.rs 的 hook_support 一致：Unlit 无 Normal/Emissive） */
const FRAGMENT_KINDS = ["physical", "toon"];
const MESH_KINDS = ["physical", "unlit", "toon"];

const NODE_HOOK_PORTS: Record<string, NodeHookPort> = {
  Vertex: {
    name: "position",
    seed: (tsl) => tsl.positionLocal,
    write: (_tsl, mat, node) => {
      (mat as unknown as { positionNode: TslNode | null }).positionNode = node;
    },
    // 顶点阶段：法线是物体空间属性（与 GL 顶点着色器里的 normal 一致）
    idents: (tsl) => ({ normal: tsl.normalLocal, uv: tsl.uv() }),
    kinds: MESH_KINDS,
  },
  Diffuse: {
    name: "diffuseColor",
    // 与 GL 注入点（color_fragment 之后）一致：rgb = color × map，a = 当前不透明度
    seed: (tsl) => tsl.vec4(tsl.materialColor.rgb, tsl.materialOpacity),
    write: (tsl, mat, node) => {
      const target = mat as unknown as { colorNode: TslNode | null; opacityNode: TslNode | null };
      // alpha 单独走 opacityNode（避免与三材质自身的不透明度相乘两次）
      target.colorNode = tsl.vec4(node.rgb, 1);
      target.opacityNode = node.a;
    },
    idents: (tsl) => ({ normal: tsl.normalView, viewDir: viewDirNode(tsl), uv: tsl.uv() }),
    kinds: MESH_KINDS,
  },
  Emissive: {
    name: "emissive",
    seed: (tsl) => tsl.materialEmissive,
    write: (_tsl, mat, node) => {
      (mat as unknown as { emissiveNode: TslNode | null }).emissiveNode = node;
    },
    idents: (tsl) => ({ normal: tsl.normalView, viewDir: viewDirNode(tsl), uv: tsl.uv() }),
    kinds: FRAGMENT_KINDS,
  },
  Normal: {
    name: "normal",
    seed: (tsl) => tsl.normalView,
    write: (_tsl, mat, node) => {
      (mat as unknown as { normalNode: TslNode | null }).normalNode = node;
    },
    idents: (tsl) => ({ normal: tsl.normalView, viewDir: viewDirNode(tsl), uv: tsl.uv() }),
    kinds: FRAGMENT_KINDS,
  },
};

/** GL 独有端口（WebGPU 下不生效，显式报告而不是静默） */
const GL_ONLY_HOOKS: Record<string, string> = {
  Fragment: "节点材质下最终颜色由引擎内部合成，Fragment 端口暂不支持（WebGL 后端可用）",
};

/** 材质 userData 上的节点 Hook 状态（uniform 节点 + 是否已接端口） */
const NODE_HOOK_KEY = "__tveNodeHooks";

interface NodeHookState {
  /** 属性名 → uniform 节点（值可变，节点复用） */
  uniforms: Record<string, TslNode>;
  /** _Time uniform 节点 */
  timeNode: TslNode;
  /** 已接端口签名（避免每次 apply 重建节点图） */
  sig: string;
}

/** 空贴图（贴图属性未指定时的兜底采样，与 GL 侧一致：采样白） */
let emptyTexture: THREE.Texture | null = null;
function emptyTextureValue(): THREE.Texture {
  if (!emptyTexture) {
    const data = new Uint8Array([255, 255, 255, 255]);
    const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    tex.needsUpdate = true;
    emptyTexture = tex;
  }
  return emptyTexture;
}

/** 属性 → 新建 uniform 节点（类型与 GL 侧 uniform 声明一致） */
function uniformNodeFor(tsl: TslFnLib, kind: string): TslNode {
  switch (kind) {
    case "color":
      return tsl.uniform(new THREE.Vector4(1, 1, 1, 1));
    case "vector":
      return tsl.uniform(new THREE.Vector4(0, 0, 0, 0));
    case "texture":
      return tsl.uniform(emptyTextureValue());
    default:
      return tsl.uniform(0);
  }
}

/** 属性值 → uniform 节点值写入（颜色 sRGB hex → 线性 vec4，与 GL 侧同规则） */
function writeUniformValue(
  tsl: TslFnLib,
  node: TslNode,
  kind: string,
  raw: number | boolean | string | number[] | undefined,
  fallback: unknown,
): void {
  const v = raw ?? fallback;
  switch (kind) {
    case "color": {
      const hex = parseColorHex(typeof v === "number" ? v : 0xffffff, 0xffffff);
      const c = new THREE.Color().setHex(hex & 0xffffff);
      (node.value as THREE.Vector4).set(c.r, c.g, c.b, 1);
      return;
    }
    case "vector": {
      const a = Array.isArray(v) ? v : [0, 0, 0, 0];
      (node.value as THREE.Vector4).set(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0);
      return;
    }
    case "int":
      node.value = Math.round(typeof v === "number" ? v : 0);
      return;
    case "texture":
      return; // 贴图由 applyTextures 异步回填
    default:
      node.value = typeof v === "number" ? v : 0;
      void tsl;
  }
}

/** 轻量文本哈希（djb2；只用于节点图重建判定，不要求抗碰撞） */
function hashText(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/**
 * 端口接线签名：钩子全文（哈希）+ CGINCLUDE + 属性集合（键 + 类型）+ 分支。
 * 与 GL 侧 hookSignature 同口径：内容敏感（同长度改代码也要重建节点图），
 * 但**不含属性值**——值只写 uniform，改值不必重建节点图。
 */
function hookSignature(kind: string, hooks: ShaderHookData): string {
  const hookSig = hooks.hooks.map((h) => `${h.name}:${hashText(h.code)}`).join("|");
  const propSig = hooks.properties.map((p) => `${p.key}:${p.kind}`).join(",");
  return `${kind}#${hooks.base}#${hookSig}#${propSig}#${hashText(hooks.include)}`;
}

/**
 * 节点材质后端：创建/判定各分支的节点材质，并把 Hook 接到端口槽位。
 * 分支配方参数（color/metalness/…）仍由工厂的经典 apply 写入（节点材质自带这些属性）。
 */
export interface NodeMaterialBackend {
  /** 后端标识（诊断用） */
  readonly id: string;
  create(kind: string): THREE.Material;
  matches(kind: string, mat: THREE.Material): boolean;
  /**
   * 应用 Hook 到节点槽位；返回"未生效"的原因列表（Fragment 端口 / 受控子集外语法），
   * 供上层告警——不静默失败。
   */
  applyHooks(
    kind: string,
    mat: THREE.Material,
    hooks: ShaderHookData,
    props: ShaderProps,
    loader?: ShaderTextureLoader,
  ): string[];
}

/** 在册的节点 Hook 材质（渲染循环推进 _Time uniform） */
const liveNodeHookMaterials = new Set<THREE.Material>();

/** 渲染循环推进：设置全部在册节点材质的 _Time（秒） */
export function tickAllNodeHookTime(seconds: number): void {
  for (const mat of liveNodeHookMaterials) {
    const state = (mat.userData as Record<string, unknown>)[NODE_HOOK_KEY] as NodeHookState | undefined;
    if (state?.timeNode) state.timeNode.value = seconds;
  }
}

/** 在册材质数量（调试/测试用） */
export function nodeHookMaterialCount(): number {
  return liveNodeHookMaterials.size;
}

class WebGpuMaterialBackend implements NodeMaterialBackend {
  readonly id = "webgpu";

  constructor(
    private readonly tsl: TslFnLib,
    private readonly classes: Record<string, new () => THREE.Material>,
  ) {}

  create(kind: string): THREE.Material {
    const Ctor = this.classes[kind] ?? this.classes.physical;
    return new Ctor();
  }

  matches(kind: string, mat: THREE.Material): boolean {
    const Ctor = this.classes[kind] ?? this.classes.physical;
    return mat instanceof Ctor;
  }

  applyHooks(
    kind: string,
    mat: THREE.Material,
    hooks: ShaderHookData,
    props: ShaderProps,
    loader?: ShaderTextureLoader,
  ): string[] {
    const tsl = this.tsl;
    const ud = mat.userData as Record<string, unknown>;
    let state = ud[NODE_HOOK_KEY] as NodeHookState | undefined;

    // uniform 节点表（属性名 → 节点；长期复用，只改值）
    if (!state) {
      const uniforms: Record<string, TslNode> = {};
      state = { uniforms, timeNode: tsl.uniform(0), sig: "" };
      ud[NODE_HOOK_KEY] = state;
      mat.addEventListener("dispose", () => liveNodeHookMaterials.delete(mat));
    }
    for (const prop of hooks.properties) {
      if (!state.uniforms[prop.key]) state.uniforms[prop.key] = uniformNodeFor(tsl, prop.kind);
      writeUniformValue(tsl, state.uniforms[prop.key], prop.kind, props[prop.key], prop.default);
    }
    this.applyTextures(hooks, props, state.uniforms, loader);

    // 端口接线（节点图变化才重建：Hook 集合/属性值/分支任一变化）
    const sig = hookSignature(kind, hooks);
    const errors: string[] = [];
    if (state.sig !== sig) {
      state.sig = sig;
      this.wirePorts(kind, mat, hooks, state, errors);
      mat.needsUpdate = true;
    } else {
      // 签名未变：仍需报告端口层面的固有不可用项（不影响渲染）
      this.reportUnsupported(kind, mat, hooks, errors);
    }
    liveNodeHookMaterials.add(mat);
    return errors;
  }

  /** Hook → 端口槽位（每个 Hook 只写自己的端口；多个 Hook 依次接线） */
  private wirePorts(
    kind: string,
    mat: THREE.Material,
    hooks: ShaderHookData,
    state: NodeHookState,
    errors: string[],
  ): void {
    const tsl = this.tsl;
    for (const hook of hooks.hooks) {
      const port = NODE_HOOK_PORTS[hook.name];
      if (!port) {
        if (GL_ONLY_HOOKS[hook.name]) errors.push(`Hook "${hook.name}" 未生效：${GL_ONLY_HOOKS[hook.name]}`);
        else errors.push(`Hook "${hook.name}" 未生效：未知端口`);
        continue;
      }
      if (!port.kinds.includes(kind)) {
        errors.push(`Hook "${hook.name}" 未生效：${kind} 分支没有 "${port.name}" 端口`);
        continue;
      }
      try {
        const node = compileHookNode({
          code: hook.code,
          include: hooks.include,
          tsl,
          port: { name: port.name, seed: port.seed(tsl, mat) },
          idents: port.idents(tsl),
          uniforms: state.uniforms,
          timeNode: state.timeNode,
        });
        port.write(tsl, mat, node);
      } catch (e) {
        const reason = e instanceof TranslateError ? e.message : String(e);
        errors.push(`Hook "${hook.name}" 未生效（转译为 TSL 失败）：${reason}`);
      }
    }
  }

  /** 签名未变时的固有不可用项（Fragment 端口 / 分支不支持） */
  private reportUnsupported(
    kind: string,
    mat: THREE.Material,
    hooks: ShaderHookData,
    errors: string[],
  ): void {
    void mat;
    for (const hook of hooks.hooks) {
      const port = NODE_HOOK_PORTS[hook.name];
      if (!port) {
        if (GL_ONLY_HOOKS[hook.name]) errors.push(`Hook "${hook.name}" 未生效：${GL_ONLY_HOOKS[hook.name]}`);
        continue;
      }
      if (!port.kinds.includes(kind)) {
        errors.push(`Hook "${hook.name}" 未生效：${kind} 分支没有 "${port.name}" 端口`);
      }
    }
  }

  /** 贴图属性回填（异步装载后写 uniform 节点的值） */
  private applyTextures(
    hooks: ShaderHookData,
    props: ShaderProps,
    uniforms: Record<string, TslNode>,
    loader?: ShaderTextureLoader,
  ): void {
    for (const prop of hooks.properties) {
      if (prop.kind !== "texture") continue;
      const node = uniforms[prop.key];
      if (!node) continue;
      const rel = props[prop.key];
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

let currentBackend: NodeMaterialBackend | null = null;

/** 安装/卸载节点材质后端（WebGPU 后端挂载时由引擎调用；null 恢复经典材质路径） */
export function setNodeMaterialBackend(backend: NodeMaterialBackend | null): void {
  currentBackend = backend;
  if (!backend) liveNodeHookMaterials.clear();
}

/** 当前节点材质后端（工厂按它决定建哪种材质、Hook 走哪条路） */
export function getNodeMaterialBackend(): NodeMaterialBackend | null {
  return currentBackend;
}

/**
 * 加载 WebGPU 节点材质后端（动态 import three/webgpu + three/tsl；
 * 未选 WebGPU 的产物不加载它们）。模块不可用时返回 null（上层保持经典材质并告警）。
 */
export async function loadNodeMaterialBackend(): Promise<NodeMaterialBackend | null> {
  try {
    const [webgpu, tslMod] = await Promise.all([import("three/webgpu"), import("three/tsl")]);
    const g = webgpu as unknown as Record<string, unknown>;
    const classes: Record<string, new () => THREE.Material> = {};
    const pick = (key: string, ...names: string[]): void => {
      for (const n of names) {
        const Ctor = g[n];
        if (typeof Ctor === "function") {
          classes[key] = Ctor as new () => THREE.Material;
          return;
        }
      }
    };
    pick("physical", "MeshPhysicalNodeMaterial");
    pick("unlit", "MeshBasicNodeMaterial");
    pick("toon", "MeshToonNodeMaterial");
    if (!classes.physical || !classes.unlit || !classes.toon) return null;
    return new WebGpuMaterialBackend(tslMod as unknown as TslFnLib, classes);
  } catch {
    return null;
  }
}
