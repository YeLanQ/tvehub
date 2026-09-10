// 网格（meshNode）构建：基元几何 + 按材质类型分派 three 材质
// （toon → MeshToonMaterial / unlit → MeshBasicMaterial / custom → ShaderMaterial
//  （自定义着色器，程序由 shaderlab.mjs 组装）/ 其余 → MeshPhysicalMaterial），
// 以及模型网格（source=model）的实例化挂载。
// 与编辑器 framework/mesh、framework/material/factory 的规则保持同步。
import * as THREE from "../core/three.module.min.js";
import { num, vec } from "../core/utils.mjs";
import { MAT_DEFAULTS, makeToonGradient, displacedGeometry } from "./material.mjs";
import { instantiateModel } from "./model.mjs";

/** 自定义着色器占位程序（程序缺失/组装失败时渲染洋红棋盘，避免无源码报错） */
const PLACEHOLDER_VERTEX = `varying vec2 vPlaceholderUv;
void main() {
  vPlaceholderUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const PLACEHOLDER_FRAGMENT = `varying vec2 vPlaceholderUv;
void main() {
  float s = floor(vPlaceholderUv.x * 8.0) + floor(vPlaceholderUv.y * 8.0);
  gl_FragColor = vec4(mix(vec3(1.0, 0.0, 1.0), vec3(0.12, 0.12, 0.12), mod(s, 2.0)), 1.0);
}
`;

/** 在册自定义材质（每帧推进 _Time；材质释放时自动出册） */
const timeMaterials = new Set();

/** 渲染循环推进：设置全部在册自定义材质的 _Time（秒） */
export function tickShaderTime(seconds) {
  if (timeMaterials.size === 0) return;
  for (const mat of timeMaterials) {
    const uniform = mat.uniforms?._Time;
    if (uniform) uniform.value = seconds;
  }
}

/** 属性值 → three uniform 初值（与编辑器 customShader.ts 同规则：
 * 颜色 sRGB hex → 线性 vec4；向量 → vec4；数值 → float；贴图 → 纹理，异步回填） */
function customUniformValue(prop, props) {
  const raw = props[prop.key];
  const value = raw === undefined ? prop.default : raw;
  switch (prop.kind) {
    case "color": {
      const hex = typeof value === "number" ? value : parseInt(String(value).replace("#", ""), 16);
      const c = new THREE.Color().setHex(Number.isFinite(hex) ? hex & 0xffffff : 0xffffff);
      return { value: [c.r, c.g, c.b, 1] };
    }
    case "vector":
      return { value: (Array.isArray(value) ? value : [0, 0, 0, 0]).slice(0, 4) };
    case "texture":
      return { value: null };
    case "int":
      return { value: Math.round(typeof value === "number" ? value : 0) };
    default:
      return { value: typeof value === "number" ? value : 0 };
  }
}

/** 自定义着色器 → ShaderMaterial（uniforms = 属性 + _Time；渲染状态取自 Tags 声明） */
function createCustomMaterial(m) {
  const program = m.program ?? null;
  const properties = m.properties ?? [];
  const uniforms = {};
  for (const prop of properties) uniforms[prop.key] = customUniformValue(prop, m.props || {});
  uniforms._Time = { value: 0 };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: program ? program.vertex : PLACEHOLDER_VERTEX,
    fragmentShader: program ? program.fragment : PLACEHOLDER_FRAGMENT,
    transparent: program ? program.transparent === true : false,
    depthWrite: program ? program.depthWrite !== false : true,
    side: !program
      ? THREE.FrontSide
      : program.side === "double"
        ? THREE.DoubleSide
        : program.side === "back"
          ? THREE.BackSide
          : THREE.FrontSide,
  });
  // 贴图属性回填用（textures.mjs 按属性表加载并写 uniform）
  mat.userData.customProperties = properties;
  mat.addEventListener("dispose", () => timeMaterials.delete(mat));
  timeMaterials.add(mat);
  return mat;
}

export function createMesh(json, ctx) {
  const obj = buildMeshNode(json, ctx);
  // 阴影参与：网格默认**投射 + 接收**（与编辑器 SceneSynchronizer 同一策略，
  // 否则平行光/聚光灯开了阴影也看不到影子）。材质轮廓体（__matOutline）例外：
  // 它是沿法线外扩的背面壳，投影会把轮廓糊进阴影里。
  obj.traverse((o) => {
    if (o.isMesh !== true || o.name === "__matOutline") return;
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
function buildMeshNode(json, ctx) {
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
  let geom;
  if (kind === "sphere") geom = new THREE.SphereGeometry(x / 2, 32, 24);
  else if (kind === "plane") geom = new THREE.PlaneGeometry(x, z);
  else if (kind === "cylinder") geom = new THREE.CylinderGeometry(x / 2, x / 2, y, 24);
  else geom = new THREE.BoxGeometry(x, y, z);

  const m = ctx.materialParams.get(json.material) || MAT_DEFAULTS;
  const f = {
    transparent: m.opacity < 0.999 || (!!m.map && !(m.alphaClipThreshold > 0.0001)),
    alphaTest: m.map && m.alphaClipThreshold > 0.0001 ? m.alphaClipThreshold : 0,
    wireframe: m.wireframe === true,
  };
  if (m.type === "custom") {
    // Custom → ShaderMaterial（GLSL 顶点/片元程序 + 属性 uniform；贴图由 textures.mjs 回填）
    return new THREE.Mesh(geom, createCustomMaterial(m));
  }
  if (m.type === "toon") {
    // Toon → MeshToonMaterial（cel shading；color/map/emissive/法线 + 灰阶渐变条分档）
    const on = m.emissionEnabled === true;
    const mat = new THREE.MeshToonMaterial({
      color: m.color & 0xffffff,
      emissive: on ? m.emissive & 0xffffff : 0x000000,
      emissiveIntensity: on ? m.emissiveIntensity : 1,
      gradientMap: makeToonGradient(m.toonSteps, m.toonShadowStrength),
      opacity: m.opacity,
      transparent: f.transparent,
      alphaTest: f.alphaTest,
      wireframe: f.wireframe,
    });
    const mesh = new THREE.Mesh(geom, mat);
    if (m.outlineEnabled === true) {
      // 轮廓体：沿法线外扩（宽度×包围半径）、只渲染背面的纯色子网格
      if (!geom.boundingSphere) geom.computeBoundingSphere();
      const radius = geom.boundingSphere ? geom.boundingSphere.radius : 1;
      const outline = new THREE.Mesh(
        displacedGeometry(geom, m.outlineWidth * radius),
        new THREE.MeshBasicMaterial({
          color: (m.outlineColor & 0xffffff) || 0x000000,
          side: THREE.BackSide,
        }),
      );
      outline.name = "__matOutline";
      mesh.add(outline);
    }
    return mesh;
  }
  if (m.type === "unlit") {
    // Unlit → MeshBasicMaterial（只映射 color/map/透明/线框，其余 PBR 项忽略）
    const mat = new THREE.MeshBasicMaterial({
      color: m.color & 0xffffff,
      opacity: m.opacity,
      transparent: f.transparent,
      alphaTest: f.alphaTest,
      wireframe: f.wireframe,
    });
    return new THREE.Mesh(geom, mat);
  }
  const mat = new THREE.MeshPhysicalMaterial({
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
  });
  return new THREE.Mesh(geom, mat);
}
