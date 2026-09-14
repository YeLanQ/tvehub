// 网页运行产物清单生成器（单一事实来源）。
//
// 扫描 public/web-preview（入口 index.html / player.mjs）与 public/engine（运行时
// 全部模块）生成 src/generated/web-preview-files.ts；两类文件体积大且按需打包，
// 各自单独分组：物理引擎（physics-engines/）按后端分组；WebGPU 运行时
// （three 的 WebGPU 构建 + 粒子 TSL 材质）按项目渲染后端决定是否随产物。
// 运行时目录里新增/删除文件后清单自动跟上，不再手工维护列表
// （曾因漏登记 layerpass.mjs 导致预览 404）。
//
// 两处调用，保证任何入口都拿到最新清单：
// - vite.config.ts 的索引插件：dev 启动 / 构建 / 运行时文件增删时重建；
// - package.json 的 build 脚本：在 vue-tsc 之前生成（干净检出时生成文件不存在，
//   晚生成会让类型检查直接报 TS2307「找不到模块」）。
//
// 用法（直接执行）：node scripts/gen-web-preview-files.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 项目根（本脚本位于 <root>/scripts/） */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 运行时源目录（相对项目根；vite 插件据此挂文件监听） */
export const WEB_PREVIEW_ROOTS = ["public/web-preview", "public/engine"];

/** 生成清单的目标文件（相对项目根） */
export const RUNTIME_FILES_PATH = "src/generated/web-preview-files.ts";

/** 物理引擎在清单键里的前缀（体积大，按后端分组按需打包） */
const PHYSICS_PREFIX = "engine/runtime/physics-engines/";

/**
 * WebGPU 运行时文件（体积大：three 的 WebGPU 构建 ~670KB + 粒子/材质 Hook 的节点
 * 实现与 GLSL→TSL 转译器）：仅在项目渲染后端为 webgpu / auto 时随产物（与物理引擎
 * 同一"按需包含"策略），其余情况播放器走 WebGL 构建，不会请求这些文件。
 */
const WEBGPU_FILES = [
  "engine/core/three.webgpu.min.js",
  "engine/core/particleNodeMaterial.mjs",
  "engine/core/glslToTsl.mjs",
  "engine/core/nodeMaterialHooks.mjs",
];

/** 导出产物始终排除的解码器文件：wasm 二进制经文本 IPC 通道会 UTF-8 损坏，
 *  且 web 运行时用 JS 版 Draco（decoderType:"js"），wasm 版与 wrapper 仅编辑器用。
 *  Basis wasm 同理——转码器 JS 单独按 textureCompressionEnabled 条件打包（见下）。 */
const EXPORT_EXCLUDED = new Set([
  "engine/runtime/loaders/draco/draco_decoder.wasm",
  "engine/runtime/loaders/draco/draco_wasm_wrapper.js",
  "engine/runtime/loaders/basis/basis_transcoder.wasm",
]);

/** Draco 解码器 JS 文件：仅当项目 resources.dracoCompression === true 时随导出产物。
 *  运行时用 decoderType:"js"，只需 draco_decoder.js；wasm 版始终排除（见上）。 */
const DRACO_DECODER_FILES = [
  "engine/runtime/loaders/draco/draco_decoder.js",
];

/** Basis 转码器 JS 文件：仅当项目 resources.textureCompression === true 时随导出产物。
 *  运行时 KTX2 解码需 basis_transcoder.js（wasm 版始终排除，转码器内置 JS 回退）。 */
const BASIS_DECODER_FILES = [
  "engine/runtime/loaders/basis/basis_transcoder.js",
];

/** 递归列出 <ROOT>/<rel> 下全部文件（返回相对 ROOT 的正斜杠路径） */
function listFilesRecursive(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const child = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...listFilesRecursive(child));
    else if (e.isFile()) out.push(child.split(path.sep).join("/"));
  }
  return out;
}

/**
 * 生成 src/generated/web-preview-files.ts，返回清单条数。
 * 清单键 = 产物内相对路径：web-preview 下剥掉 public/web-preview/ 前缀
 * （index.html / player.mjs），engine 下剥掉 public/ 前缀（engine/**）。
 */
export function generateWebPreviewFiles() {
  const entries = listFilesRecursive("public/web-preview")
    .map((f) => f.replace(/^public\/web-preview\//, ""))
    .concat(listFilesRecursive("public/engine").map((f) => f.replace(/^public\//, "")));

  // 基础清单：web-preview 入口 + engine 运行时
  // （物理引擎按后端分组、WebGPU 运行时按渲染后端、Draco/Basis 解码器按资源配置，
  //  四者单独分组见下）
  const conditionalDecoders = new Set([...DRACO_DECODER_FILES, ...BASIS_DECODER_FILES]);
  const base = entries
    .filter(
      (f) =>
        !f.startsWith(PHYSICS_PREFIX) &&
        !WEBGPU_FILES.includes(f) &&
        !EXPORT_EXCLUDED.has(f) &&
        !conditionalDecoders.has(f),
    )
    .sort();

  const byBackend = {};
  for (const f of entries) {
    if (!f.startsWith(PHYSICS_PREFIX)) continue;
    const rest = f.slice(PHYSICS_PREFIX.length);
    const backend = rest.includes("/")
      ? rest.slice(0, rest.indexOf("/"))
      : rest.replace(/\.mjs$/, "");
    (byBackend[backend] ??= []).push(f);
  }
  for (const k of Object.keys(byBackend)) byBackend[k].sort();

  const webgpu = WEBGPU_FILES.filter((f) => entries.includes(f));

  const content =
    `// 由 scripts/gen-web-preview-files.mjs 自动生成（vite 启动/构建与 pnpm build\n` +
    `// 时重建；请勿手动编辑）\n` +
    `export const WEB_PREVIEW_RUNTIME_FILES: string[] = ${JSON.stringify(base, null, 2)};\n` +
    `export const WEB_PREVIEW_PHYSICS_FILES_BY_BACKEND: Record<string, string[]> = ${JSON.stringify(byBackend, null, 2)};\n` +
    `export const WEB_PREVIEW_WEBGPU_FILES: string[] = ${JSON.stringify(webgpu, null, 2)};\n` +
    `export const WEB_PREVIEW_DRACO_DECODER_FILES: string[] = ${JSON.stringify(DRACO_DECODER_FILES, null, 2)};\n` +
    `export const WEB_PREVIEW_BASIS_DECODER_FILES: string[] = ${JSON.stringify(BASIS_DECODER_FILES, null, 2)};\n`;
  const target = path.join(ROOT, RUNTIME_FILES_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return base.length;
}

// 直接执行（node scripts/gen-web-preview-files.mjs）：生成并打印结果
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const count = generateWebPreviewFiles();
  console.log(`[gen-web-preview-files] 已生成 ${count} 项 → ${RUNTIME_FILES_PATH}`);
}
