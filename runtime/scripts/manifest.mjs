// 渠道运行时清单生成器（单一事实来源）：扫描 web（public/web-preview +
// public/engine）与 wechat（public/exports/wechat/runtime）两渠道的运行时产物，
// 生成统一清单 src/generated/channel-runtimes.ts——前端 runtime-supply 据此按
// 渠道 + 项目配置拉取运行时文本。目录新增/删除文件后清单自动跟上，不再手工
// 维护列表（曾因漏登记 layerpass.mjs 导致预览 404）。
//
// 条件组（体积大的可选运行时按需打包）：
// - web：physics:<ammo|jolt|rapier>（按后端，胶水 .mjs + 同目录 .wasm 文件——
//   运行时经全局钩子加载 .wasm，不再内联进 JS）、webgpu（three WebGPU 构建 + 粒子
//   TSL 材质）、draco / basis（解码器胶水 JS + .wasm，按项目资源配置）
// - wechat：physics:<rapier|jolt|ammo>（CJS 预转换产物，按项目物理后端随包）
//
// 两处调用，保证任何入口都拿到最新清单：
// - vite.config.ts 的索引插件：dev 启动 / 构建 / 运行时文件增删时重建；
// - package.json 的 build 脚本：在 vue-tsc 之前生成（干净检出时生成文件不存在，
//   晚生成会让类型检查直接报 TS2307「找不到模块」）。
//
// 用法（直接执行）：node runtime/scripts/manifest.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 项目根（本脚本位于 <root>/runtime/scripts/） */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 运行时源目录（相对项目根；vite 插件据此挂文件监听） */
export const CHANNEL_RUNTIME_ROOTS = [
  "public/web-preview",
  "public/engine",
  "public/exports/wechat/runtime",
];

/** 生成清单的目标文件（相对项目根） */
export const CHANNEL_RUNTIMES_PATH = "src/generated/channel-runtimes.ts";

/** 物理引擎在清单键里的前缀（体积大，按后端分组按需打包） */
const PHYSICS_PREFIX = "engine/runtime/physics-engines/";

/**
 * WebGPU 运行时文件（体积大：three 的 WebGPU 构建 + 粒子/材质 Hook 的节点
 * 实现与 GLSL→TSL 转译器）：仅在项目渲染后端为 webgpu / auto 时随产物。
 */
const WEBGPU_FILES = [
  "engine/core/three.webgpu.min.js",
  "engine/core/particleNodeMaterial.mjs",
  "engine/core/glslToTsl.mjs",
  "engine/core/nodeMaterialHooks.mjs",
];

/** Draco/Basis 解码器（wasm 形态：胶水 JS + .wasm 二进制；three 的
 *  DRACOLoader/KTX2Loader 主线程取数后 postMessage 进解码 Worker）：
 *  仅当项目启用对应压缩时随导出产物。wasm 二进制经前端 base64 过 IPC，
 *  Rust 管线按字节写盘/内联（runtime-supply 的 .wasm 特判）。 */
const DRACO_DECODER_FILES = [
  "engine/runtime/loaders/draco/draco_wasm_wrapper.js",
  "engine/runtime/loaders/draco/draco_decoder.wasm",
];
const BASIS_DECODER_FILES = [
  "engine/runtime/loaders/basis/basis_transcoder.js",
  "engine/runtime/loaders/basis/basis_transcoder.wasm",
];

/** 导出产物始终排除的文件：draco_decoder.js 为纯 JS 解码器（web 运行时与编辑器
 *  均用 wasm 解码器形态），仅留在本地产物目录，不随任何产物分发。 */
const EXPORT_EXCLUDED = new Set(["engine/runtime/loaders/draco/draco_decoder.js"]);

/** 微信渠道随包的物理引擎文件前缀（CJS 预转换产物；键 = 产物内相对路径，
 *  前缀下第一段目录/文件名（剥 .js）即后端 id：rapier.js / jolt.js / ammo/**） */
const WECHAT_PHYSICS_PREFIX = "engine/runtime/physics-engines/";

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

/** web 渠道清单：key = 产物内相对路径（= public 下路径），rel 同 key */
function scanWeb() {
  const entries = listFilesRecursive("public/web-preview")
    .map((f) => f.replace(/^public\/web-preview\//, ""))
    .concat(listFilesRecursive("public/engine").map((f) => f.replace(/^public\//, "")));

  const conditionalDecoders = new Set([...DRACO_DECODER_FILES, ...BASIS_DECODER_FILES]);
  const base = entries
    .filter(
      (f) =>
        !f.startsWith(PHYSICS_PREFIX) &&
        !WEBGPU_FILES.includes(f) &&
        !EXPORT_EXCLUDED.has(f) &&
        !conditionalDecoders.has(f),
    )
    .sort()
    .map((f) => ({ key: f, rel: f, url: f.startsWith("engine/") ? `/${f}` : `/web-preview/${f}` }));

  const byBackend = {};
  for (const f of entries) {
    if (!f.startsWith(PHYSICS_PREFIX)) continue;
    const rest = f.slice(PHYSICS_PREFIX.length);
    const backend = rest.includes("/")
      ? rest.slice(0, rest.indexOf("/"))
      : rest.replace(/\.(mjs|wasm)$/, "");
    (byBackend[backend] ??= []).push(f);
  }
  const groups = {};
  for (const k of Object.keys(byBackend).sort()) {
    groups[`physics:${k}`] = byBackend[k].sort().map((f) => ({ key: f, rel: f, url: `/${f}` }));
  }
  groups.webgpu = WEBGPU_FILES.filter((f) => entries.includes(f))
    .sort()
    .map((f) => ({ key: f, rel: f, url: f.startsWith("engine/") ? `/${f}` : `/web-preview/${f}` }));
  groups.draco = DRACO_DECODER_FILES.filter((f) => entries.includes(f)).map((f) => ({ key: f, rel: f, url: `/${f}` }));
  groups.basis = BASIS_DECODER_FILES.filter((f) => entries.includes(f)).map((f) => ({ key: f, rel: f, url: `/${f}` }));
  return { id: "web", base, groups };
}

/** wechat 渠道清单：key = 包内相对路径（剥 exports/wechat/runtime/ 前缀），
 *  rel = public 下路径（前端 fetch URL = /<rel>）。数据键不经过文件系统
 *  （全内联），键保持原大小写；包内代码文件名由导出管线统一小写。 */
function scanWechat() {
  const all = listFilesRecursive("public/exports/wechat/runtime").map((f) => {
    const rel = f.replace(/^public\//, "");
    return {
      key: f.replace(/^public\/exports\/wechat\/runtime\//, ""),
      rel,
      url: `/${rel}`,
    };
  });
  const base = all
    .filter((f) => !f.key.startsWith(WECHAT_PHYSICS_PREFIX))
    .sort((a, b) => a.key.localeCompare(b.key));
  // 物理引擎按后端分组（与 web 渠道同规则：前缀下第一段目录，否则剥扩展名；
  // 胶水 .js 与随包 .wasm 归同一后端组）
  const byBackend = {};
  for (const f of all) {
    if (!f.key.startsWith(WECHAT_PHYSICS_PREFIX)) continue;
    const rest = f.key.slice(WECHAT_PHYSICS_PREFIX.length);
    const backend = rest.includes("/")
      ? rest.slice(0, rest.indexOf("/"))
      : rest.replace(/\.(js|mjs|wasm)$/, "");
    (byBackend[backend] ??= []).push(f);
  }
  const groups = {};
  for (const k of Object.keys(byBackend).sort()) {
    groups[`physics:${k}`] = byBackend[k].sort((a, b) => a.key.localeCompare(b.key));
  }
  return {
    id: "wechat",
    base,
    groups,
  };
}

/** 生成 src/generated/channel-runtimes.ts，返回各渠道清单条数 */
export function generateChannelRuntimes() {
  const web = scanWeb();
  const wechat = scanWechat();
  const content =
    `// 由 runtime/scripts/manifest.mjs 自动生成（vite 启动/构建与 pnpm build\n` +
    `// 时重建；请勿手动编辑。双渠道运行时清单统一事实源）\n` +
    `export interface ChannelRuntimeFile { key: string; rel: string; url: string; }\n` +
    `export interface ChannelRuntimeSpec { id: "web" | "wechat"; base: ChannelRuntimeFile[]; groups: Record<string, ChannelRuntimeFile[]>; }\n` +
    `export const CHANNEL_RUNTIMES: Record<"web" | "wechat", ChannelRuntimeSpec> = ${JSON.stringify({ web, wechat }, null, 2)};\n`;
  const target = path.join(ROOT, CHANNEL_RUNTIMES_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return { web: web.base.length + Object.values(web.groups).flat().length, wechat: wechat.base.length + Object.values(wechat.groups).flat().length };
}

// 直接执行（node runtime/scripts/manifest.mjs）：生成并打印结果
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const counts = generateChannelRuntimes();
  console.log(`[manifest] 已生成双渠道清单 → ${CHANNEL_RUNTIMES_PATH}（web ${counts.web} 项 / wechat ${counts.wechat} 项）`);
}
