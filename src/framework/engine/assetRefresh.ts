// ---------------------------------------------------------------------------
// 资产刷新与预取（编辑器侧缓存接线）：贴图加载/失效、材质/着色器/模型引用
// 刷新、装载期预取（贴图双通道变体 + 材质及其着色器）。
// TextureCube（.texcube）的天空装载走 skyEnv.ts 的版本化缓存。
// ---------------------------------------------------------------------------
import * as THREE from "three";
import type { EditorEngine } from "./EditorEngine";
import { AudioNode, MeshNode, UIImageNode } from "../prototype/derived/Primitives";
import { loadTexCubeTexture } from "./skyEnv";
import { resyncNavAreas } from "./navSources";

/**
 * 按相对路径异步加载贴图（带缓存，经 asset:// 协议由浏览器直接解码图片）。
 * srgb=true 表示颜色贴图（Base/Emissive），false 表示数据贴图（Metallic/Roughness/Normal）。
 */
export function loadTexture(engine: EditorEngine, rel: string, srgb: boolean): Promise<THREE.Texture | null> {
  const key = `${srgb ? "c" : "n"}|${rel}`;
  const cached = engine.textureCache.get(key);
  if (cached) return cached;
  const task = (async (): Promise<THREE.Texture | null> => {
    const resolver = engine.textureUrlResolver;
    if (!resolver || !rel) return null;
    const url = resolver(rel);
    if (!url) return null;
    return await new Promise((resolve) => {
      engine.textureLoader.load(
        url,
        (tex) => {
          tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          resolve(tex);
        },
        undefined,
        () => resolve(null),
      );
    });
  })().catch(() => null);
  engine.textureCache.set(key, task);
  return task;
}

/**
 * 外部（磁盘改写等）通知某贴图内容已更新：清除该资产的加载缓存并刷新所有
 * 引用方（材质网格按参数重新取图 / 粒子贴图重装 / UI 图片清签名重填 /
 * 天空重算）。asset:// 协议本身 no-store，重取即得新字节；未引用该贴图时
 * 材质扫描不命中，无刷新开销。
 */
export function invalidateTexture(engine: EditorEngine, rel: string): void {
  if (!rel) return;
  for (const key of [...engine.textureCache.keys()]) {
    if (key.endsWith(`|${rel}`)) engine.textureCache.delete(key);
  }
  engine.skyEpoch++;
  engine.applySkyFromGraph();
  // 粒子贴图走同一缓存：重装加载器使全部绑定按当前缓存重取（未失效的贴图
  // 命中缓存承诺，无重复解码）
  engine.particles.setTextureLoader((r) => loadTexture(engine, r, true));
  // 材质网格：扫描已解析材质参数是否引用该贴图，命中才刷新（材质参数是
  // 纯 JSON 值，序列化串包含 rel 即视为引用；误报仅多刷一次，无副作用）
  for (const matRel of engine.materials.loadedRels()) {
    if (!JSON.stringify(engine.materials.paramsFor(matRel)).includes(rel)) continue;
    refreshMaterialNodes(engine, matRel);
  }
  // UI 图片节点：路径签名相同时回填被跳过，先清签名再重刷
  for (const node of engine.graph.all()) {
    if (node instanceof UIImageNode && node.image === rel) {
      engine.synchronizer.refreshUIImage(node);
    }
  }
}

/**
 * 材质资产参数保存后：刷新引用该材质的所有网格外观并广播 material:changed。
 * rel 为空时刷新全部网格材质（装载/迁移后兜底用）。
 */
export function refreshMaterialNodes(engine: EditorEngine, rel?: string | null): void {
  for (const node of engine.graph.all()) {
    if (!(node instanceof MeshNode)) continue;
    if (node.source !== "model") {
      if (rel == null || node.material === rel) {
        engine.synchronizer.refreshMeshMaterial(node);
      }
      continue;
    }
    // 模型覆盖材质：rel 命中覆盖表 → 失效缓存（下一帧应用时按新参数重建）并重刷
    const overrides = node.modelMaterialOverrides;
    const hit =
      rel != null &&
      Object.values(overrides).some((v) => v === rel);
    if (hit) engine.synchronizer.invalidateModelOverrideMaterial(rel);
    if (rel == null || hit) engine.synchronizer.refreshModelMeshMaterials(node);
  }
  engine.events.emit("material:changed", { rel: rel ?? "" });
}

/**
 * 着色器文档（重新）解析后：刷新引用该着色器的全部材质所挂网格
 * （渲染分支变更即时生效：源码保存、首次加载完成、撤销/重做切回引用）。
 * rel 为空时刷新全部网格材质。
 */
export function refreshShaderNodes(engine: EditorEngine, shaderRel?: string | null): void {
  for (const node of engine.graph.all()) {
    if (!(node instanceof MeshNode)) continue;
    if (shaderRel == null || engine.materials.shaderFor(node.material) === shaderRel) {
      engine.synchronizer.refreshMeshMaterial(node);
    }
  }
}

/**
 * 预取贴图引用：颜色/数据两种通道变体都装填缓存（材质编译与粒子/地形/UI
 * 取图时直接命中，避免揭幕后贴图逐张弹入）；.texcube 走天空盒装载路径。
 * onProgress 可选：逐项汇报进度（项目装载蒙版用）。
 */
export async function preloadTextures(
  engine: EditorEngine,
  rels: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  let done = 0;
  for (const rel of rels) {
    if (engine.isDisposed()) return;
    if (rel.toLowerCase().endsWith(".texcube")) {
      await loadTexCubeTexture(engine, rel);
    } else {
      await Promise.all([loadTexture(engine, rel, true), loadTexture(engine, rel, false)]);
    }
    onProgress?.(++done, rels.length);
  }
}

/**
 * 预取材质引用及其挂载的着色器：节点入图即按正确外观渲染
 * （渲染分支与 Hook 都先取到再刷新，避免先默认外观后跳变）。
 * onProgress 可选：逐项汇报材质预取进度（项目装载蒙版用）。
 */
export async function preloadMaterials(
  engine: EditorEngine,
  rels: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (rels.length === 0) return;
  if (onProgress) {
    let done = 0;
    for (const rel of rels) {
      await engine.materials.preload([rel]);
      onProgress(++done, rels.length);
    }
  } else {
    await engine.materials.preload(rels);
  }
  if (engine.isDisposed()) return;
  const shaderRels = [
    ...new Set(
      rels
        .map((rel) => engine.materials.shaderFor(rel))
        .filter((rel) => rel.length > 0),
    ),
  ];
  if (shaderRels.length > 0) {
    await engine.shaders.preload(shaderRels);
    if (engine.isDisposed()) return;
  }
  refreshMaterialNodes(engine, null);
}

/**
 * 模型资产解析完成后：刷新引用该模型的所有网格（实例替换 + 动画重绑）
 * 并广播 model:changed。rel 为空时刷新全部模型网格。
 */
export function refreshModelNodes(engine: EditorEngine, rel?: string | null): void {
  let touched = false;
  for (const node of engine.graph.all()) {
    if (
      node instanceof MeshNode &&
      node.source === "model" &&
      (rel == null || node.model === rel)
    ) {
      engine.synchronizer.refreshMeshNode(node);
      touched = true;
    }
  }
  engine.animation.setSelected(engine.selectedId);
  // 模型几何换入（占位体 → 实例）：网格源范围、合并高度场与障碍 AABB 缓存可能过期
  if (touched) {
    engine.navMeshBoundsCache.clear();
    engine.navFieldCache.clear();
    engine.navObstacleCache = null;
    resyncNavAreas(engine);
  }
  engine.events.emit("model:changed", { rel: rel ?? "" });
}

/** 音源图标状态着色刷新（音频绑定/加载/失败状态变化后内部调用） */
export function refreshAudioNodeIcon(engine: EditorEngine, nodeId: string): void {
  const n = engine.graph.get(nodeId);
  if (n instanceof AudioNode) engine.synchronizer.refreshAudioNodeIcon(n);
}
