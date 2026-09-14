// 网格贴图回填：导出产物内的贴图文件按 .mat 通道相对路径异步加载
// （ResourceLoader + ImageBitmap → Texture，带缓存），就地表到材质通道上。
import * as THREE from "../core/three.module.min.js";
import { resourceLoader } from "./resource";

// 贴图通道 → 是否 sRGB（颜色贴图 sRGB，数据贴图线性）
const TEXTURE_CHANNELS = [
  ["map", true],
  ["metalnessMap", false],
  ["roughnessMap", false],
  ["normalMap", false],
  ["emissiveMap", true],
];

/** 加载相对路径贴图（同路径同色彩空间共享缓存；失败返回 null）。
 * imageOrientation: "flipY" 必须显式指定——WebGL 对 ImageBitmap 上传忽略
 * UNPACK_FLIP_Y_WEBGL，不预翻转贴图会上下颠倒（与编辑器 TextureLoader 不一致）。
 * 导出供其它回放系统复用（粒子贴图等），texCache 由调用方持有。 */
export function loadImageTex(texCache, rel, srgb) {
  const key = `${srgb ? "c" : "n"}|${rel}`;
  if (texCache.has(key)) return texCache.get(key);
  const p = resourceLoader
    .loadImageBitmap(rel)
    .then((bmp) => {
      if (!bmp) return null;
      const tex = new THREE.Texture(bmp);
      tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      tex.needsUpdate = true;
      return tex;
    })
    .catch(() => null);
  texCache.set(key, p);
  return p;
}

/** 逐网格按材质声明回填贴图（贴图文件已在导出产物内，按相对路径 fetch）。
 * unlit 只支持基础色贴图 map；toon 无金属/粗糙通道；
 * 着色器 Properties 的贴图参数（props 值）：按属性表加载后写入该材质的钩子
 * uniform 表（shaderHooks.mjs 在 userData 上维护同一批对象）。 */
export async function applyMeshTextures(meshes, materialParams) {
  const texCache = new Map();
  await Promise.all(
    meshes.map(async (entry) => {
      const mat = entry.obj.material;
      if (!mat) return;
      const m = materialParams.get(entry.json.material);
      if (!m) return;
      if (m.shaderData) {
        const table = mat.userData?.__tveHookUniforms ?? (mat.userData?.__tveNodeHooks ? mat.userData.__tveNodeHooks.uniforms : undefined);
        const props = m.props || {};
        for (const prop of m.shaderData.properties || []) {
          if (prop.kind !== "texture") continue;
          const uniform = table ? table[prop.key] : null;
          if (!uniform) continue;
          const rel = typeof props[prop.key] === "string" ? props[prop.key] : "";
          if (!rel) {
            uniform.value = null;
            continue;
          }
          uniform.value = await loadImageTex(texCache, rel, true);
        }
      }
      const basicOnly = mat.type === "MeshBasicMaterial";
      const isToon = mat.type === "MeshToonMaterial";
      for (const [field, srgb] of TEXTURE_CHANNELS) {
        if (basicOnly && field !== "map") continue;
        if (isToon && (field === "metalnessMap" || field === "roughnessMap")) continue;
        if (isToon && field === "emissiveMap" && !m.emissionEnabled) continue;
        const rel = m[field];
        if (!rel) continue;
        const tex = await loadImageTex(texCache, rel, srgb);
        if (!tex) continue;
        mat[field] = tex;
        if (field === "normalMap") mat.normalScale.set(1, 1);
        mat.needsUpdate = true;
      }
    }),
  );
}

