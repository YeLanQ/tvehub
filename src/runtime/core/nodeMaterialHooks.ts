// ---------------------------------------------------------------------------
// 着色器 Hook 的 WebGPU（节点材质）后端（预览/运行时侧）。
//
// 与编辑器 src/framework/material/nodeMaterialBackend.ts 同规则双份实现：把 .shader
// 的 Hook 片段翻译为 TSL 节点，接到内置节点材质的端口槽位，使同一份 .shader 在
// WebGL（onBeforeCompile 注入 GLSL）与 WebGPU（节点槽位）下语义一致：
//   Vertex   → positionNode   端口 position（物体空间）
//   Diffuse  → colorNode      端口 diffuseColor（rgb = 基色 × 贴图，a = 不透明度）
//   Emissive → emissiveNode   端口 emissive（= GL 的 totalEmissiveRadiance）
//   Normal   → normalNode     端口 normal（视空间法线）
//   Fragment → GL 独有：节点路径下最终颜色由引擎内部合成，本后端显式报告不生效
// 只读环境：normal（视空间法线，顶点端口为物体空间）/ viewDir（视空间视线）/
//   uv / _Time；Properties → TSL uniform 节点。
// 本模块静态依赖 three 的 WebGPU 构建（THREE.TSL + 各 NodeMaterial 类），
// 由 player 在 WebGPU 后端下动态 import（与粒子 TSL 材质同一策略）。
// ---------------------------------------------------------------------------
import * as THREE from "./three.webgpu.min.js";
import { compileHookNode } from "./glslToTsl";

const TSL = THREE.TSL;

/** 支持端口的渲染分支（与后端 shader.rs 的 hook_support 一致：Unlit 无 Normal/Emissive） */
const MESH_KINDS = ["physical", "unlit", "toon"];
const FRAGMENT_KINDS = ["physical", "toon"];

/** GL 独有端口（WebGPU 下不生效，显式报告而不是静默） */
const GL_ONLY_HOOKS = {
  Fragment: "节点材质下最终颜色由引擎内部合成，Fragment 端口暂不支持（WebGL 后端可用）",
};

/** 端口定义（与编辑器侧 NODE_HOOK_PORTS 对齐） */
const NODE_HOOK_PORTS = {
  Vertex: {
    name: "position",
    seed: () => TSL.positionLocal,
    write: (mat, node) => {
      mat.positionNode = node;
    },
    idents: () => ({ normal: TSL.normalLocal, uv: TSL.uv() }),
    kinds: MESH_KINDS,
  },
  Diffuse: {
    name: "diffuseColor",
    seed: () => TSL.vec4(TSL.materialColor.rgb, TSL.materialOpacity),
    write: (mat, node) => {
      mat.colorNode = TSL.vec4(node.rgb, 1);
      mat.opacityNode = node.a;
    },
    idents: () => ({ normal: TSL.normalView, viewDir: viewDirNode(), uv: TSL.uv() }),
    kinds: MESH_KINDS,
  },
  Emissive: {
    name: "emissive",
    seed: () => TSL.materialEmissive,
    write: (mat, node) => {
      mat.emissiveNode = node;
    },
    idents: () => ({ normal: TSL.normalView, viewDir: viewDirNode(), uv: TSL.uv() }),
    kinds: FRAGMENT_KINDS,
  },
  Normal: {
    name: "normal",
    seed: () => TSL.normalView,
    write: (mat, node) => {
      mat.normalNode = node;
    },
    idents: () => ({ normal: TSL.normalView, viewDir: viewDirNode(), uv: TSL.uv() }),
    kinds: FRAGMENT_KINDS,
  },
};

/** 视空间视线方向（与 GL 的 normalize(vViewPosition) 等价：-mvPosition 归一化） */
function viewDirNode() {
  return TSL.positionView.negate().normalize();
}

const NODE_HOOK_KEY = "__tveNodeHooks";

/** 空贴图（贴图属性未指定时的兜底采样，与 GL 侧一致：采样白） */
let emptyTex = null;
function emptyTexture() {
  if (!emptyTex) {
    const data = new Uint8Array([255, 255, 255, 255]);
    const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    tex.needsUpdate = true;
    emptyTex = tex;
  }
  return emptyTex;
}

/** 属性 → uniform 节点（类型与 GL 侧 uniform 声明一致） */
function uniformNodeFor(kind) {
  switch (kind) {
    case "color":
      return TSL.uniform(new THREE.Vector4(1, 1, 1, 1));
    case "vector":
      return TSL.uniform(new THREE.Vector4(0, 0, 0, 0));
    case "texture":
      return TSL.uniform(emptyTexture());
    default:
      return TSL.uniform(0);
  }
}

/** 属性值 → uniform 值写入（颜色 sRGB hex → 线性 vec4，与 GL 侧同规则） */
function writeUniformValue(node, kind, value) {
  switch (kind) {
    case "color": {
      const hex = typeof value === "number" ? value : 0xffffff;
      const c = new THREE.Color().setHex(hex & 0xffffff);
      node.value.set(c.r, c.g, c.b, 1);
      return;
    }
    case "vector": {
      const a = Array.isArray(value) ? value : [0, 0, 0, 0];
      node.value.set(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0);
      return;
    }
    case "int":
      node.value = Math.round(typeof value === "number" ? value : 0);
      return;
    case "texture":
      return; // 贴图异步回填
    default:
      node.value = typeof value === "number" ? value : 0;
  }
}

/** 是否支持该分支的节点材质类可用（WebGPU 构建缺 TSL/节点材质时不启用） */
function classesAvailable() {
  return [
    THREE.MeshPhysicalNodeMaterial,
    THREE.MeshBasicNodeMaterial,
    THREE.MeshToonNodeMaterial,
  ].every((c) => typeof c === "function");
}

/**
 * 创建节点材质后端；WebGPU 构建不含节点材质/TSL 时返回 null（调用方保持 GLSL 路径）。
 */
export function createNodeMaterialBackend() {
  if (!TSL || typeof TSL.Fn !== "function" || !classesAvailable()) return null;

  const classes = {
    physical: THREE.MeshPhysicalNodeMaterial,
    unlit: THREE.MeshBasicNodeMaterial,
    toon: THREE.MeshToonNodeMaterial,
  };
  const live = new Set();

  /** 节点材质类（供 mesh.mjs 按分支创建；未启用时调用方用经典材质） */
  function classFor(kind) {
    return classes[kind] ?? classes.physical;
  }

  function matches(kind, mat) {
    const Ctor = classes[kind] ?? classes.physical;
    return mat instanceof Ctor;
  }

  /** 应用 Hook 到端口槽位；返回"未生效"的原因列表（不静默失败） */
  function applyHooks(kind, mat, hooks, props) {
    const errors = [];
    let state = mat.userData[NODE_HOOK_KEY];
    if (!state) {
      state = { uniforms: {}, timeNode: TSL.uniform(0), sig: "" };
      mat.userData[NODE_HOOK_KEY] = state;
      mat.addEventListener("dispose", () => live.delete(mat));
    }
    for (const prop of hooks.properties || []) {
      if (!state.uniforms[prop.key]) state.uniforms[prop.key] = uniformNodeFor(prop.kind);
      const raw = props ? props[prop.key] : undefined;
      writeUniformValue(state.uniforms[prop.key], prop.kind, raw === undefined ? prop.default : raw);
    }
    // 贴图属性：导出产物内的贴图由 textures.mjs 按同一 uniform 表回填（与 GL 侧一致）
    for (const prop of hooks.properties || []) {
      if (prop.kind !== "texture") continue;
      const node = state.uniforms[prop.key];
      if (node && !node.value) node.value = emptyTexture();
    }

    const sig = `${kind}#${hooks.base}#${hooks.hooks.map((h) => `${h.name}:${h.code.length}`).join("|")}#${hooks.include.length}`;
    if (state.sig === sig) {
      reportUnsupported(kind, hooks, errors);
      live.add(mat);
      return errors;
    }
    state.sig = sig;

    for (const hook of hooks.hooks || []) {
      const port = NODE_HOOK_PORTS[hook.name];
      if (!port) {
        errors.push(
          GL_ONLY_HOOKS[hook.name]
            ? `Hook "${hook.name}" 未生效：${GL_ONLY_HOOKS[hook.name]}`
            : `Hook "${hook.name}" 未生效：未知端口`,
        );
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
          tsl: TSL,
          port: { name: port.name, seed: port.seed() },
          idents: port.idents(),
          uniforms: state.uniforms,
          timeNode: state.timeNode,
        });
        port.write(mat, node);
      } catch (e) {
        errors.push(`Hook "${hook.name}" 未生效（转译为 TSL 失败）：${e && e.message ? e.message : e}`);
      }
    }
    mat.needsUpdate = true;
    live.add(mat);
    return errors;
  }

  /** 签名未变时的固有不可用项（Fragment 端口 / 分支不支持） */
  function reportUnsupported(kind, hooks, errors) {
    for (const hook of hooks.hooks || []) {
      const port = NODE_HOOK_PORTS[hook.name];
      if (!port) {
        if (GL_ONLY_HOOKS[hook.name]) {
          errors.push(`Hook "${hook.name}" 未生效：${GL_ONLY_HOOKS[hook.name]}`);
        }
        continue;
      }
      if (!port.kinds.includes(kind)) {
        errors.push(`Hook "${hook.name}" 未生效：${kind} 分支没有 "${port.name}" 端口`);
      }
    }
  }

  /** 渲染循环推进：节点侧 _Time（秒） */
  function tickTime(seconds) {
    if (live.size === 0) return;
    for (const mat of live) {
      const state = mat.userData[NODE_HOOK_KEY];
      if (state && state.timeNode) state.timeNode.value = seconds;
    }
  }

  return { id: "webgpu", classFor, matches, applyHooks, tickTime };
}

/** 贴图属性 uniform 回填（textures.mjs 用：按 .mat 的 props 引用加载贴图后写节点值） */
export function writeHookTexture(mat, key, texture) {
  const state = mat.userData ? mat.userData[NODE_HOOK_KEY] : null;
  const node = state ? state.uniforms[key] : null;
  if (node) node.value = texture ?? emptyTexture();
}
