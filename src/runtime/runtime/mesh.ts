// 网格（meshNode）构建：基元几何 + 按材质类型分派 three 材质
// （toon → MeshToonMaterial / unlit → MeshBasicMaterial / 其余 → MeshPhysicalMaterial），
// 以及模型网格（source=model）的实例化挂载。
// 自定义着色效果由材质所挂 .shader 的 Hook 片段以注入方式叠加在上述内置材质上
// （shaderHooks.mjs），不替换渲染分支。
// 基元构造与数据化网格解码单源自编辑器 framework/mesh（geometry.ts 注册表 +
// dataGeometry.ts 解码），本文件只保留播放端差异：构建期共享缓存（同参数只建
// 一份、运行期只读）与损坏回退策略（null → 基元占位，编辑器侧为可见报错）。
import * as THREE from "../core/three.module.min.js";
import { num, vec } from "../core/utils";
import { buildGeometry } from "../../framework/mesh/geometry";
import { buildDataGeometry, parseMeshData } from "../../framework/mesh/dataGeometry";
import { MAT_DEFAULTS, makeToonGradient, displacedGeometry } from "./material";
import type { MaterialParam } from "./material";
import { instantiateModel } from "./model";
import { applyShaderHooks as applyHooks, tickAllHookTime } from "./shaderHooks";
import type { ShaderData } from "./material";
import type { NodeJson } from "./node-json";
import type { BuildSceneCtx } from "./nodes";

/** 节点材质后端（WebGPU TSL 实现；player 注入，null = 经典 three 材质 + GLSL 注入） */
interface NodeMaterialBackend {
  /** 渲染分支 key → 节点材质构造器（toon/unlit/physical） */
  classFor(kind: string): new (parameters?: Record<string, unknown>) => THREE.Material;
  /** TSL 端口 Hook 注入；返回逐项告警文案 */
  applyHooks(
    kind: string,
    mat: THREE.Material,
    shaderData: ShaderData,
    props: Record<string, unknown>,
  ): string[];
  tickTime(seconds: number): void;
}

/** 渲染循环的着色器时间推进（钩子的 _Time uniform；秒） */
export function tickShaderTime(seconds: number): void {
  tickAllHookTime(seconds);
  if (nodeBackend) nodeBackend.tickTime(seconds);
}

let nodeBackend: NodeMaterialBackend | null = null;

/** 注入节点材质后端（WebGPU）；null 恢复经典材质路径 */
export function setNodeMaterialBackend(backend: NodeMaterialBackend | null): void {
  nodeBackend = backend ?? null;
}

/** 按分支创建材质：节点后端激活时用节点材质（WebGPU），否则用经典 three 材质 */
function createBranchMaterial(
  kind: string,
  Ctor: new (options: Record<string, unknown>) => THREE.Material,
  options: Record<string, unknown>,
): THREE.Material {
  return nodeBackend ? new (nodeBackend.classFor(kind))(options) : new Ctor(options);
}

/** 应用着色器 Hook：节点后端走 TSL 端口（未生效项显式告警），否则注入 GLSL */
function applyBranchHooks(kind: string, mat: THREE.Material, m: MaterialParam): void {
  if (!m.shaderData) return;
  if (nodeBackend) {
    const errors = nodeBackend.applyHooks(kind, mat, m.shaderData, m.props || {});
    for (const message of errors) console.warn("[tve] " + message);
    return;
  }
  applyHooks(mat, m.shaderData, m.props || {});
}

/** 材质解析失败的告警去重（同一引用只报一次，避免逐网格刷屏） */
const warnedMissingMaterials = new Set<string>();

/**
 * 引用了未随产物的材质（.mat 缺失/解析失败）→ 回退默认材质，但必须**可见地**告警：
 * 否则表现为"材质变成一块纯灰"，容易误判成渲染后端或着色器的问题。
 */
function warnMissingMaterial(rel: string, nodeName: unknown): void {
  if (warnedMissingMaterials.has(rel)) return;
  warnedMissingMaterials.add(rel);
  console.warn("[tve] 材质未解析，已回退默认材质: " + rel + "（首个引用它的网格: " + (nodeName || "?") + "）");
}

// —— 构建期共享缓存：同参数只建一份，运行期只读 ——
// 导出产物常含大量同规格基元网格；共享后 GPU 顶点缓冲、WebGL 着色程序数与
// WebGPU 管线数按"参数种数"而非网格数增长（模型实例经 SkeletonUtils.clone 本就
// 共享几何/材质，基元对齐同一策略）。运行时无销毁/改写这些资源的路径（节点移除
// 不 dispose），脚本 API 也不暴露几何/材质改写。
const primitiveGeometryCache = new Map<string, THREE.BufferGeometry>();
const branchMaterialCache = new WeakMap<object, THREE.Material>();
const outlineMaterialCache = new WeakMap<object, THREE.MeshBasicMaterial>();

/** 按种类+尺寸取基元几何（相同参数共享一份 BufferGeometry；构造单源 framework/mesh） */
function getPrimitiveGeometry(kind: string, x: number, y: number, z: number): THREE.BufferGeometry {
  const key = `${kind}|${x}|${y}|${z}`;
  let geom = primitiveGeometryCache.get(key);
  if (geom === undefined) {
    geom = buildGeometry(kind, { x, y, z });
    primitiveGeometryCache.set(key, geom);
  }
  return geom;
}

/** 数据化网格载荷（节点 dataMesh 字段的解码读面） */
interface DataMeshPayload {
  vertexCount?: unknown;
  positions?: unknown;
  indices?: unknown;
  indexCount?: unknown;
  normals?: unknown;
  uvs?: unknown;
}

/** 载荷 → BufferGeometry（按载荷长度签名共享；损坏回退占位方块——解码单源
 *  framework/mesh/dataGeometry，播放端把"编辑器可见报错"适配为 null 回退） */
function getDataGeometry(payload: DataMeshPayload): THREE.BufferGeometry | null {
  const d = parseMeshData(payload);
  if (!d) return null;
  const key = `data|${d.positions.length}|${d.indices.length}|${d.vertexCount}|${d.indexCount}`;
  const cached = primitiveGeometryCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const geom = buildDataGeometry(d);
    primitiveGeometryCache.set(key, geom);
    return geom;
  } catch {
    return null;
  }
}

/** 按解析后的 .mat 参数对象取共享材质（同引用网格共用一个材质实例；
 * 贴图回填/Hook 注入按参数幂等，共享后各网格渲染结果不变） */
function sharedBranchMaterial(m: object, build: () => THREE.Material): THREE.Material {
  let mat = branchMaterialCache.get(m);
  if (mat === undefined) {
    mat = build();
    branchMaterialCache.set(m, mat);
  }
  return mat;
}

/** 描边壳材质只取 outlineColor：同参数网格共享一份 */
function sharedOutlineMaterial(m: MaterialParam): THREE.MeshBasicMaterial {
  let mat = outlineMaterialCache.get(m);
  if (mat === undefined) {
    mat = new THREE.MeshBasicMaterial({
      color: (m.outlineColor & 0xffffff) || 0x000000,
      side: THREE.BackSide,
    });
    outlineMaterialCache.set(m, mat);
  }
  return mat;
}

export function createMesh(json: NodeJson, ctx: BuildSceneCtx): THREE.Object3D {
  const obj = buildMeshNode(json, ctx);
  // 阴影参与：网格默认**投射 + 接收**（与编辑器 SceneSynchronizer 同一策略，
  // 否则平行光/聚光灯开了阴影也看不到影子）。材质轮廓体（__matOutline）例外：
  // 它是沿法线外扩的背面壳，投影会把轮廓糊进阴影里。
  obj.traverse((o: THREE.Object3D) => {
    if ((o as THREE.Mesh).isMesh !== true || o.name === "__matOutline") return;
    o.castShadow = true;
    o.receiveShadow = true;
  });
  return obj;
}

/**
 * 生成 meshNode 的 three 对象：
 * - 模型网格（source=model）：实例化已解析的模型（SkeletonUtils.clone）挂为子级
 *   __modelRoot（与编辑器 SceneSynchronizer 同名约定，动画绑定据此取实例）；
 *   未绑定/加载失败时渲染空组占位，避免按基元规则画出一个误导性的默认方块；
 * - 基元网格：按 geometry/size 生成几何；
 * - 材质按 .mat 资产引用解析（缺失回退默认参数）；类型缺省回退 PBR。
 *   透明/裁剪规则与编辑器一致：opacity<1 半透明；贴图阈值>0 走 alphaTest 裁剪。
 */
function buildMeshNode(json: NodeJson, ctx: BuildSceneCtx): THREE.Object3D {
  if (json.source === "model") {
    const container = new THREE.Group();
    const rel = typeof json.model === "string" ? json.model : "";
    const inst = rel ? instantiateModel(ctx.models, rel) : null;
    if (inst) {
      inst.name = "__modelRoot";
      inst.userData.modelRel = rel;
      inst.userData.sharedResources = true; // 几何/材质与缓存模板共享，移除时不 dispose
      container.add(inst);
    }
    return container;
  }
  const kind = json.geometry || "box";
  const sz = vec(json.size, { x: 1, y: 1, z: 1 });
  const x = Math.max(0.01, num(sz.x, 1));
  const y = Math.max(0.01, num(sz.y, 1));
  const z = Math.max(0.01, num(sz.z, 1));
  // 数据化网格（source=data）：载荷解码（同载荷共享）；无载荷/损坏回退基元占位
  const dataGeom =
    json.source === "data" && json.dataMesh
      ? getDataGeometry(json.dataMesh as DataMeshPayload)
      : null;
  const geom = dataGeom || getPrimitiveGeometry(kind as string, x, y, z);

  // 材质解析：引用缺失（.mat 未随产物/解析失败）时回退默认材质 —— 但必须**可见地**告警，
  // 否则表现为"材质变成一块纯灰"，让人误以为是渲染后端或着色器的问题
  const matRel = json.material;
  const resolved = typeof matRel === "string" ? ctx.materialParams.get(matRel) : undefined;
  if (!resolved && matRel) warnMissingMaterial(String(matRel), json.name);
  const m = resolved || MAT_DEFAULTS;
  const f = {
    transparent: m.opacity < 0.999 || (!!m.map && !(m.alphaClipThreshold > 0.0001)),
    // 裁剪阈值钳到 <1：three 的 WebGL alphaTest 是"alpha < 阈值才 discard"（alpha=1
    // 恒通过），WebGPU 节点路径是小于等于语义——阈值取 1 会把不透明片元全部
    // discard，网格在 WebGPU 下整块消失
    alphaTest:
      m.map && m.alphaClipThreshold > 0.0001 ? Math.min(m.alphaClipThreshold, 0.999) : 0,
    wireframe: m.wireframe === true,
  };
  if (m.type === "toon") {
    // Toon → MeshToonMaterial（cel shading；color/map/emissive/法线 + 灰阶渐变条分档）
    const on = m.emissionEnabled === true;
    const mat = sharedBranchMaterial(m, () =>
      createBranchMaterial("toon", THREE.MeshToonMaterial, {
        color: m.color & 0xffffff,
        emissive: on ? m.emissive & 0xffffff : 0x000000,
        emissiveIntensity: on ? m.emissiveIntensity : 1,
        gradientMap: makeToonGradient(m.toonSteps, m.toonShadowStrength),
        opacity: m.opacity,
        transparent: f.transparent,
        alphaTest: f.alphaTest,
        wireframe: f.wireframe,
      }),
    );
    // 着色器 Hook 注入/接线（如有；共享材质只注入一次）
    applyBranchHooks("toon", mat, m);
    const mesh = new THREE.Mesh(geom, mat);
    if (m.outlineEnabled === true) {
      // 轮廓体：沿法线外扩（宽度×包围半径）、只渲染背面的纯色子网格
      if (!geom.boundingSphere) geom.computeBoundingSphere();
      const radius = geom.boundingSphere ? geom.boundingSphere.radius : 1;
      const outline = new THREE.Mesh(
        displacedGeometry(geom, m.outlineWidth * radius),
        sharedOutlineMaterial(m),
      );
      outline.name = "__matOutline";
      mesh.add(outline);
    }
    return mesh;
  }
  if (m.type === "unlit") {
    // Unlit → MeshBasicMaterial（只映射 color/map/透明/线框，其余 PBR 项忽略）
    const mat = sharedBranchMaterial(m, () =>
      createBranchMaterial("unlit", THREE.MeshBasicMaterial, {
        color: m.color & 0xffffff,
        opacity: m.opacity,
        transparent: f.transparent,
        alphaTest: f.alphaTest,
        wireframe: f.wireframe,
      }),
    );
    // 着色器 Hook 注入/接线（如有）
    applyBranchHooks("unlit", mat, m);
    return new THREE.Mesh(geom, mat);
  }
  const mat = sharedBranchMaterial(m, () =>
    createBranchMaterial("physical", THREE.MeshPhysicalMaterial, {
      color: m.color & 0xffffff,
      metalness: m.metalness,
      roughness: m.roughness,
      specularIntensity: m.specularIntensity,
      specularColor: m.specularColor & 0xffffff,
      ior: m.ior,
      emissive: m.emissive & 0xffffff,
      emissiveIntensity: m.emissiveIntensity,
      clearcoat: m.clearcoat,
      clearcoatRoughness: m.clearcoatRoughness,
      sheen: m.sheen,
      sheenColor: m.sheenColor & 0xffffff,
      sheenRoughness: m.sheenRoughness,
      transmission: m.transmission,
      thickness: m.thickness,
      attenuationColor: m.attenuationColor & 0xffffff,
      attenuationDistance: m.attenuationDistance,
      anisotropy: m.anisotropy,
      anisotropyRotation: m.anisotropyRotation,
      iridescence: m.iridescence,
      iridescenceIOR: m.iridescenceIOR,
      opacity: m.opacity,
      transparent: f.transparent,
      alphaTest: f.alphaTest,
      wireframe: f.wireframe,
    }),
  );
  // 着色器 Hook 注入/接线（如有）
  applyBranchHooks("physical", mat, m);
  return new THREE.Mesh(geom, mat);
}
