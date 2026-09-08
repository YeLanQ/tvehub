// 网页运行产物（public/web-preview）共享读取：网页预览面板与构建导出面板共用，
// 避免两处文件清单漂移。运行时随编辑器打包（离线可用），fetch 一次以文本传入 Rust。

/** public/web-preview 下的网页运行产物清单：入口 index.html + player.mjs，
 *  其余依赖模块与 three 运行时都在 libs/ 下 */
export const WEB_PREVIEW_RUNTIME_FILES = [
  "index.html",
  "player.mjs",
  "libs/three.core.min.js",
  "libs/three.module.min.js",
  "libs/utils.mjs",
  "libs/log.mjs",
  "libs/sky.mjs",
  "libs/material.mjs",
  "libs/mesh.mjs",
  "libs/animclip.mjs",
  "libs/nodes.mjs",
  "libs/textures.mjs",
  "libs/camera.mjs",
  "libs/stage.mjs",
  "libs/pak.mjs",
  "libs/model.mjs",
  "libs/animation.mjs",
  "libs/audio.mjs",
  "libs/physics.mjs",
  "libs/tve.mjs",
  "libs/scripts.mjs",
  "libs/loaders/GLTFLoader.js",
  "libs/loaders/FBXLoader.js",
  "libs/loaders/OBJLoader.js",
  "libs/loaders/SkeletonUtils.js",
  "libs/loaders/BufferGeometryUtils.js",
  "libs/loaders/fflate.module.js",
  "libs/loaders/NURBSCurve.js",
  "libs/loaders/NURBSUtils.js",
];

/**
 * 物理引擎（体积大：rapier/jolt 3MB 级、ammo wasm 内联 1MB 级）。
 * 仅当导出场景启用了物理（settings.physics.physicsEnabled === true）时才随产物
 * 打包；libs/physics.mjs 本体极小（在基础清单内），其引擎加载是惰性的——
 * 场景未启用物理时不会请求这些文件。
 */
export const WEB_PREVIEW_PHYSICS_FILES = [
  "libs/physics-engines/rapier.mjs",
  "libs/physics-engines/jolt.mjs",
  "libs/physics-engines/ammo/ammo-esm.mjs",
  "libs/physics-engines/ammo/ammo-glue.mjs",
  "libs/physics-engines/ammo/ammo-wasm-b64.mjs",
];

export interface WebPreviewRuntimeOptions {
  /** 场景启用了物理 → 物理运行时随导出（缺省 false） */
  includePhysics?: boolean;
}

/** 读取网页运行产物文本（相对 public 根），key 为产物内相对路径 */
export async function fetchWebPreviewRuntimeTexts(
  opts?: WebPreviewRuntimeOptions,
): Promise<Record<string, string>> {
  const list = opts?.includePhysics
    ? [...WEB_PREVIEW_RUNTIME_FILES, ...WEB_PREVIEW_PHYSICS_FILES]
    : WEB_PREVIEW_RUNTIME_FILES;
  const files: Record<string, string> = {};
  for (const rel of list) {
    const url = `/web-preview/${rel}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`读取网页运行时失败: ${url} (${res.status})`);
    files[rel] = await res.text();
  }
  return files;
}

/**
 * 解析项目配置文本是否启用物理（physics.physicsEnabled === true）。
 * 文本读取失败/解析失败一律视为未启用（导出按未用物理处理）。
 */
export function configUsesPhysics(configText: string | null | undefined): boolean {
  if (!configText) return false;
  try {
    const cfg = JSON.parse(configText) as { physics?: { physicsEnabled?: unknown } };
    return cfg.physics?.physicsEnabled === true;
  } catch {
    return false;
  }
}

/** 替换 index.html 的 <title>（构建渠道自定义页面标题用） */
export function withHtmlTitle(html: string, title: string): string {
  if (!title.trim()) return html;
  return html.replace(/<title>[\s\S]*?<\/title>/, `<title>${title.trim()}</title>`);
}
