// 网格贴图回填：导出产物内的贴图文件按 .mat 通道相对路径异步加载
// （ResourceLoader + ImageBitmap → Texture，带缓存），就地表到材质通道上。
import * as THREE from "../core/three.module.min.js";
import { resourceLoader } from "./resource";
import type { NodeJson } from "./node-json";

/** 贴图通道 → 是否 sRGB（颜色贴图 sRGB，数据贴图线性） */
const TEXTURE_CHANNELS: [field: string, srgb: boolean][] = [
  ["map", true],
  ["metalnessMap", false],
  ["roughnessMap", false],
  ["normalMap", false],
  ["emissiveMap", true],
];

/** 场景网格条目（buildSceneTree 产出） */
interface TextureMeshEntry {
  json: NodeJson;
  obj: THREE.Mesh;
}

/** .mat 材质参数回填写面（shaderData/通道路径/发射开关） */
interface MatParam {
  shaderData?: { properties?: { kind?: string; key?: string }[] };
  props?: Record<string, unknown>;
  emissionEnabled?: boolean;
  /** 贴图通道相对路径（map/metalnessMap/…，随 field 动态读写） */
  [key: string]: unknown;
}

/** 材质 userData 上的 hook uniform 表（shaderHooks 维护，同一批对象） */
type HookUniformTable = Record<string, { value: unknown } | undefined>;

/** 加载相对路径贴图（同路径同色彩空间共享缓存；失败返回 null）。
 * imageOrientation: "flipY" 必须显式指定——WebGL 对 ImageBitmap 上传忽略
 * UNPACK_FLIP_Y_WEBGL，不预翻转贴图会上下颠倒（与编辑器 TextureLoader 不一致）。
 * 导出供其它回放系统复用（粒子贴图等），texCache 由调用方持有。 */
export function loadImageTex(
  texCache: Map<string, Promise<THREE.Texture | null>>,
  rel: string,
  srgb: boolean,
): Promise<THREE.Texture | null> {
  const key = `${srgb ? "c" : "n"}|${rel}`;
  const hit = texCache.get(key);
  if (hit) return hit;
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
export async function applyMeshTextures(
  meshes: TextureMeshEntry[],
  materialParams: Map<string, MatParam>,
): Promise<void> {
  const texCache = new Map<string, Promise<THREE.Texture | null>>();
  await Promise.all(
    meshes.map(async (entry) => {
      // 多材质数组在运行时走动态属性访问的降级路径，断言为单材质类型保行为
      const mat = entry.obj.material as THREE.Material;
      if (!mat) return;
      const matRel = entry.json.material;
      const m = typeof matRel === "string" ? materialParams.get(matRel) : undefined;
      if (!m) return;
      if (m.shaderData) {
        const ud = mat.userData as {
          __tveHookUniforms?: HookUniformTable;
          __tveNodeHooks?: { uniforms?: HookUniformTable };
        };
        const table = ud.__tveHookUniforms ?? (ud.__tveNodeHooks ? ud.__tveNodeHooks.uniforms : undefined);
        const props = m.props || {};
        for (const prop of m.shaderData.properties || []) {
          if (prop.kind !== "texture") continue;
          const key = prop.key;
          if (typeof key !== "string") continue;
          const uniform = table ? table[key] : null;
          if (!uniform) continue;
          const raw = props[key];
          const rel = typeof raw === "string" ? raw : "";
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
        const tex = await loadImageTex(texCache, String(rel), srgb);
        if (!tex) continue;
        // 通道字段按材质子类存在（map/normalMap/…），动态写入走索引断言
        (mat as unknown as Record<string, unknown>)[field] = tex;
        if (field === "normalMap") (mat as THREE.MeshStandardMaterial).normalScale.set(1, 1);
        mat.needsUpdate = true;
      }
    }),
  );
}
