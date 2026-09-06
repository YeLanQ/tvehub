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
  "libs/nodes.mjs",
  "libs/textures.mjs",
  "libs/camera.mjs",
  "libs/stage.mjs",
  "libs/pak.mjs",
  "libs/model.mjs",
  "libs/animation.mjs",
  "libs/loaders/GLTFLoader.js",
  "libs/loaders/FBXLoader.js",
  "libs/loaders/OBJLoader.js",
  "libs/loaders/SkeletonUtils.js",
  "libs/loaders/BufferGeometryUtils.js",
  "libs/loaders/fflate.module.js",
  "libs/loaders/NURBSCurve.js",
  "libs/loaders/NURBSUtils.js",
];

/** 读取网页运行产物文本（相对 public 根），key 为产物内相对路径 */
export async function fetchWebPreviewRuntimeTexts(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const rel of WEB_PREVIEW_RUNTIME_FILES) {
    const url = `/web-preview/${rel}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`读取网页运行时失败: ${url} (${res.status})`);
    files[rel] = await res.text();
  }
  return files;
}

/** 替换 index.html 的 <title>（构建渠道自定义页面标题用） */
export function withHtmlTitle(html: string, title: string): string {
  if (!title.trim()) return html;
  return html.replace(/<title>[\s\S]*?<\/title>/, `<title>${title.trim()}</title>`);
}
