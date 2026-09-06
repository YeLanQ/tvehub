// 网格贴图回填：导出产物内的贴图文件按 .mat 通道相对路径异步加载
// （fetch + ImageBitmap → Texture，带缓存），就地表到材质通道上。
import * as THREE from "./three.module.min.js";

// 贴图通道 → 是否 sRGB（颜色贴图 sRGB，数据贴图线性）
const TEXTURE_CHANNELS = [
  ["map", true],
  ["metalnessMap", false],
  ["roughnessMap", false],
  ["normalMap", false],
  ["emissiveMap", true],
];

/** 加载相对路径贴图（同路径同色彩空间共享缓存；失败返回 null） */
function loadImageTex(texCache, rel, srgb) {
  const key = `${srgb ? "c" : "n"}|${rel}`;
  if (texCache.has(key)) return texCache.get(key);
  const p = fetch(rel)
    .then((r) => (r.ok ? r.blob() : null))
    .then((blob) => (blob ? createImageBitmap(blob) : null))
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
 * unlit 只支持基础色贴图 map；toon 无金属/粗糙通道。 */
export async function applyMeshTextures(meshes, materialParams) {
  const texCache = new Map();
  for (const entry of meshes) {
    const mat = entry.obj.material;
    if (!mat) continue;
    const m = materialParams.get(entry.json.material);
    if (!m) continue;
    const basicOnly = mat.type === "MeshBasicMaterial"; // unlit：只支持基础色贴图 map
    const isToon = mat.type === "MeshToonMaterial"; // toon：无金属/粗糙通道
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
  }
}
