// 模型资产（glb/gltf/fbx/obj）加载与实例化：镜像编辑器 ModelManager + loaders.ts。
// - 模型文件已随导出产物拷贝到同相对路径，这里按引用 fetch 二进制并解析；
// - .gltf/FBX 的外部资源（.bin/贴图）经 LoadingManager URL 修饰器解析为
//   模型同目录的导出相对地址；
// - 实例化用 SkeletonUtils.clone（蒙皮网格必须重建骨骼绑定，普通网格共享几何/材质）；
// - 解析失败的引用记为 null（节点回退空组，postLog 告警）。
import * as THREE from "./three.module.min.js";
import { GLTFLoader } from "./loaders/GLTFLoader.js";
import { FBXLoader } from "./loaders/FBXLoader.js";
import { OBJLoader } from "./loaders/OBJLoader.js";
import { clone as skeletonClone } from "./loaders/SkeletonUtils.js";
import { postLog } from "./log.mjs";

/** 收集场景树里 meshNode(source=model) 的模型引用（去重） */
export function collectModelRefs(rootJson) {
  const refs = [];
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    if (o.type === "meshNode" && o.source === "model" && typeof o.model === "string" && o.model && !refs.includes(o.model)) {
      refs.push(o.model);
    }
    if (Array.isArray(o.children)) o.children.forEach(walk);
  })(rootJson);
  return refs;
}

/** 模型目录（"a/b/m.glb" → "a/b"；根目录为 ""） */
function modelDirOf(rel) {
  const i = rel.lastIndexOf("/");
  return i >= 0 ? rel.slice(0, i) : "";
}

/**
 * 加载器给出的资源地址 → 模型同目录的导出相对路径（"./a/b/xx.bin"）。
 * 绝对地址（http/data/blob 等）与无法归一化的地址返回 null（调用方放行原地址）；
 * 加载器可能已把 resourcePath（模型目录）拼进地址，先剥掉该前缀再按同目录归一化。
 */
function resolveSiblingUrl(modelDir, url) {
  const raw = url.split("?")[0];
  if (!raw || /^(https?:|data:|blob:|file:)/i.test(raw)) return null;
  let rel = decodeURIComponent(raw).replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!rel || /^[a-zA-Z]:/.test(rel)) return null;
  const prefix = modelDir ? `${modelDir}/` : "";
  if (prefix && rel.startsWith(prefix)) rel = rel.slice(prefix.length);
  const joined = modelDir ? `${modelDir}/${rel}` : rel;
  const parts = [];
  for (const seg of joined.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  if (!parts.length) return null;
  return `./${parts.join("/")}`;
}

/**
 * 发布模式 .bin 模型（LQENBIN1 容器：8 字节魔数 + u32 kind + u32 len + payload）解包：
 * - kind=1：payload 为原始 GLB 字节（含内嵌材质/动画）→ 交 GLTFLoader；
 * - kind=0：payload 为 OBJ 顶点网格（u32 verts/norms/uvs/faces + f32 数组 + u32 索引）
 *   → 重建 BufferGeometry（无法线时 computeVertexNormals，默认材质）。
 */
function parseBinModel(buffer) {
  const u8 = new Uint8Array(buffer);
  if (u8.length < 28) throw new Error(".bin 模型数据不完整");
  const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3], u8[4], u8[5], u8[6], u8[7]);
  if (magic !== "LQENBIN1") throw new Error(".bin 模型魔数不匹配");
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const kind = dv.getUint32(8, true);
  if (kind === 1) {
    return { kind: 1, glb: u8.slice(16) }; // slice 拷贝出独立 buffer（offset=0）
  }
  if (kind === 0) {
    const verts = dv.getUint32(12, true);
    const norms = dv.getUint32(16, true);
    const uvs = dv.getUint32(20, true);
    const faces = dv.getUint32(24, true);
    let off = 28;
    const pos = new Float32Array(u8.buffer, u8.byteOffset + off, verts * 3);
    off += verts * 12;
    const hasNorms = norms > 0;
    const nor = hasNorms ? new Float32Array(u8.buffer, u8.byteOffset + off, norms * 3) : null;
    off += norms * 12;
    const hasUvs = uvs > 0;
    const uv = hasUvs ? new Float32Array(u8.buffer, u8.byteOffset + off, uvs * 2) : null;
    off += uvs * 8;
    const idx = new Uint32Array(u8.buffer, u8.byteOffset + off, faces * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    if (nor) geometry.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    if (uv) geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geometry.setIndex(new THREE.BufferAttribute(idx, 1));
    if (!hasNorms) geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xffffff }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return { kind: 0, template: mesh };
  }
  throw new Error("不支持的 .bin 模型 kind: " + kind);
}

/** 按扩展名解析模型二进制 → { template, clips }（与编辑器 loaders.ts 同一套规则）；
 *  发布模式的 .bin先解包：kind=1 走 GLTFLoader，kind=0 直接重建网格 */
async function parseModel(rel, buffer) {
  const ext = rel.includes(".") ? rel.split(".").pop().toLowerCase() : "";
  const dir = modelDirOf(rel);
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    const resolved = resolveSiblingUrl(dir, url);
    return resolved ?? url;
  });
  const resourcePath = dir ? `${dir}/` : "";
  if (ext === "bin") {
    const parsed = parseBinModel(buffer);
    if (parsed.kind === 0) {
      return { template: parsed.template, clips: [] };
    }
    const gltf = await new Promise((resolve, reject) => {
      new GLTFLoader(manager).parse(
        parsed.glb,
        resourcePath,
        (gltf) => resolve(gltf),
        (err) => reject(new Error(`glTF 解析失败: ${String(err ?? "未知错误")}`)),
      );
    });
    return { template: gltf.scene, clips: gltf.animations ?? [] };
  }
  if (ext === "glb" || ext === "gltf") {
    const gltf = await new Promise((resolve, reject) => {
      new GLTFLoader(manager).parse(
        buffer,
        resourcePath,
        (gltf) => resolve(gltf),
        (err) => reject(new Error(`glTF 解析失败: ${String(err ?? "未知错误")}`)),
      );
    });
    return { template: gltf.scene, clips: gltf.animations ?? [] };
  }
  if (ext === "fbx") {
    const object = new FBXLoader(manager).parse(buffer, resourcePath);
    return { template: object, clips: object.animations ?? [] };
  }
  if (ext === "obj") {
    const object = new OBJLoader(manager).parse(new TextDecoder().decode(buffer));
    return { template: object, clips: [] };
  }
  throw new Error(`不支持的模型格式: ${rel}（支持 glTF/GLB/FBX/OBJ）`);
}

/**
 * 预取解析场景引用的全部模型 → 缓存表（rel → { template, clips }；失败项为 null）。
 * 模板设置投影/受影（与编辑器一致；克隆副本继承）。模板本身不入场景，仅作克隆源。
 */
export async function loadModels(rootJson) {
  const models = new Map();
  for (const rel of collectModelRefs(rootJson)) {
    try {
      const r = await fetch(rel);
      if (!r.ok) throw new Error(`模型文件读取失败: HTTP ${r.status}`);
      const buffer = await r.arrayBuffer();
      const { template, clips } = await parseModel(rel, buffer);
      template.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      models.set(rel, { template, clips });
    } catch (e) {
      models.set(rel, null);
      postLog("warn", `模型加载失败 ${rel}: ${String(e instanceof Error ? e.message : e)}`);
    }
  }
  return models;
}

/** 实例化模型（同步）：未就绪/加载失败返回 null（调用方渲染空组占位） */
export function instantiateModel(models, rel) {
  const m = models.get(rel);
  return m ? skeletonClone(m.template) : null;
}

/** 模型内嵌动画剪辑（未就绪返回空） */
export function modelClips(models, rel) {
  const m = models.get(rel);
  return m ? m.clips : [];
}
