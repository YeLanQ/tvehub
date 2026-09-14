// ---------------------------------------------------------------------------
// 把 three 的运行时构建与模型加载器（GLTF/FBX/OBJ/DRACO）vendor 进网页预览运行时：
// - three 构建 → public/engine/core/（three.module.min.js = WebGL 渲染器 +
//   three.core.min.js 共享核心；three.webgpu.min.js = WebGPU 渲染器，同样依赖
//   three.core.min.js，故两套渲染器共享同一份核心类，场景对象可互用）；
// - 模型加载器 → public/engine/runtime/loaders/（离线可用）；
// - Draco JS 解码器 → loaders/draco/（压缩 glTF 预览/导出必需；见 DRACO_DECODER_FILES
//   注释说明为何不用 wasm 版）。
//
// 用法：node scripts/vendor-preview-loaders.mjs
// 升级 three 后重跑即可同步（含 WebGPU 构建）；若上游出现新的未知 import
// 会直接报错退出，避免静默产出缺依赖的文件。
// ---------------------------------------------------------------------------
import { copyFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const threeDir = join(root, "node_modules", "three");
const outDir = join(root, "public", "engine", "runtime", "loaders");
const coreDir = join(root, "public", "engine", "core");

const threeVersion = JSON.parse(readFileSync(join(threeDir, "package.json"), "utf8")).version;

/** three 运行时构建（public/engine/core/）：字节与 npm 包一致，不改写 */
const THREE_BUILDS = ["three.core.min.js", "three.module.min.js", "three.webgpu.min.js"];

// 源路径（相对 examples/jsm）→ 目标文件名 + 相对 import 重写规则 [+ 模块级补丁]
const FILES = [
  { src: "loaders/GLTFLoader.js", rewrites: { "../utils/BufferGeometryUtils.js": "./BufferGeometryUtils.js", "../utils/SkeletonUtils.js": "./SkeletonUtils.js" } },
  {
    src: "loaders/DRACOLoader.js",
    rewrites: {},
    // 单页导出会把运行时模块内联为 blob（import.meta.url 变 blob: URL，相对解析
    // 抛 Invalid URL）。DRACOLoader 模块顶层的 new URL(..., import.meta.url) 只用于
    // 构造函数的缺省 decoderPaths 字符串（compressed.mjs 恒经 setDecoderPath 覆盖，
    // 缺省值永不取数），改写为纯字符串占位。上游升级若文本变化，includes 断言显式失败。
    patches: [
      [
        "const WASM_BIN_URL = new URL( '../libs/draco/draco_decoder.wasm', import.meta.url ).toString();",
        "const WASM_BIN_URL = '../libs/draco/draco_decoder.wasm';",
      ],
      [
        "const WASM_JS_URL = new URL( '../libs/draco/draco_wasm_wrapper.js', import.meta.url ).toString();",
        "const WASM_JS_URL = '../libs/draco/draco_wasm_wrapper.js';",
      ],
      [
        "const JS_URL = new URL( '../libs/draco/draco_decoder.js', import.meta.url ).toString();",
        "const JS_URL = '../libs/draco/draco_decoder.js';",
      ],
      [
        "js: new URL( '../libs/draco/gltf/draco_wasm_wrapper.js', import.meta.url ).toString(),",
        "js: '../libs/draco/gltf/draco_wasm_wrapper.js',",
      ],
      [
        "wasm: new URL( '../libs/draco/gltf/draco_decoder.wasm', import.meta.url ).toString(),",
        "wasm: '../libs/draco/gltf/draco_decoder.wasm',",
      ],
    ],
  },
  { src: "loaders/FBXLoader.js", rewrites: { "../libs/fflate.module.js": "./fflate.module.js", "../curves/NURBSCurve.js": "./NURBSCurve.js" } },
  { src: "loaders/OBJLoader.js", rewrites: {} },
  { src: "libs/meshopt_decoder.module.js", rewrites: {} },
  { src: "utils/SkeletonUtils.js", rewrites: {} },
  { src: "utils/BufferGeometryUtils.js", rewrites: {} },
  { src: "libs/fflate.module.js", rewrites: {} },
  { src: "curves/NURBSCurve.js", rewrites: { "../curves/NURBSUtils.js": "./NURBSUtils.js" } },
  { src: "curves/NURBSUtils.js", rewrites: {} },
  { src: "animation/CCDIKSolver.js", rewrites: {} },
];

/** Draco 解码器（examples/jsm/libs/draco/gltf/ → loaders/draco/，字节复制）。
 *  固定 JS 版：运行时文件经「文本 IPC」通道分发（预览/导出/远程预览共用），
 *  二进制 wasm 无法安全通过（UTF-8 往返损坏）；JS 解码慢约一倍，属加载期
 *  一次性成本（编辑器视口走 wasm 快路径，不受影响）。 */
const DRACO_DECODER_FILES = ["draco_decoder.js"];

const header = (src) =>
  `// Vendored from three@${threeVersion} examples/jsm/${src}\n` +
  `// 由 scripts/vendor-preview-loaders.mjs 生成（import 已重写指向预览运行时本地文件），请勿手改。\n`;

mkdirSync(outDir, { recursive: true });
const rewritten = [];
for (const { src, rewrites, patches = [] } of FILES) {
  const from = join(threeDir, "examples", "jsm", src);
  let text = readFileSync(from, "utf8");
  // three 裸导入（含多行 import 块结尾的 "} from 'three';"）→ 本地 three 运行时
  text = text.replace(/from\s+'three';/g, "from '../../core/three.module.min.js';");
  for (const [fromRel, toRel] of Object.entries(rewrites)) {
    text = text.split(`from '${fromRel}'`).join(`from '${toRel}'`);
  }
  // 模块级补丁（如 blob 内联不安全的 import.meta.url 定位）：逐条精确替换，
  // 上游文本变化导致找不到时显式失败，避免静默产出带病文件
  for (const [find, replace] of patches) {
    if (!text.includes(find)) {
      throw new Error(`${src} 补丁未命中（上游文本已变化）: ${find}`);
    }
    text = text.replace(find, replace);
  }
  // 残留未知相对/裸 import（上游结构变化）→ 显式失败，避免产出缺依赖文件。
  // "three/…" 只出现在 JSDoc 的 @three_import 文档行里，不是真实 import，放行。
  const unknown = [...text.matchAll(/from\s+'([^']+)';/g)]
    .map((m) => m[1])
    .filter((s) => s !== "../../core/three.module.min.js" && !s.startsWith("./") && !s.startsWith("three/"));
  if (unknown.length) {
    throw new Error(`${src} 存在未处理的 import: ${unknown.join(", ")}（请更新 vendor 脚本的 rewrites）`);
  }
  writeFileSync(join(outDir, src.split("/").pop()), header(src) + text);
  rewritten.push(src);
}
// fflate 无 import，复制即用（上面已覆盖；此处仅提示来源一致）
console.log(`已 vendor ${rewritten.length} 个文件到 public/engine/runtime/loaders/（three@${threeVersion}）`);

// 单页导出会把运行时模块内联为 blob（import.meta.url 相对解析抛 Invalid URL）：
// loaders 目录不得残留 import.meta.url（DRACOLoader 已补丁改写为字符串占位）
for (const name of rewritten.map((s) => s.split("/").pop())) {
  const text = readFileSync(join(outDir, name), "utf8");
  if (text.includes("import.meta.url")) {
    throw new Error(`${name} 残留 import.meta.url（单页内联 blob 下会抛 Invalid URL，请加 patches）`);
  }
}

// Draco wasm 解码器：字节复制到 loaders/draco/（compressed.mjs 经 import.meta.url 定位）
const dracoDir = join(outDir, "draco");
mkdirSync(dracoDir, { recursive: true });
for (const name of DRACO_DECODER_FILES) {
  copyFileSync(join(threeDir, "examples", "jsm", "libs", "draco", "gltf", name), join(dracoDir, name));
}
console.log(`已 vendor ${DRACO_DECODER_FILES.length} 个 Draco 解码器文件到 loaders/draco/`);

// three 运行时构建：字节复制（不改写），含 WebGPU 构建供预览/导出的 WebGPU 后端使用
mkdirSync(coreDir, { recursive: true });
for (const name of THREE_BUILDS) {
  copyFileSync(join(threeDir, "build", name), join(coreDir, name));
  // 依赖校验：构建只允许依赖同目录的 three.core.min.js（无裸导入，浏览器可直接加载）
  const deps = [...readFileSync(join(coreDir, name), "utf8").matchAll(/from\s*"([^"]+)"/g)]
    .map((m) => m[1])
    .filter((s) => s !== "./three.core.min.js");
  if (deps.length) {
    throw new Error(`${name} 存在未预期的依赖: ${deps.join(", ")}（预览运行时无打包器，不能有裸导入）`);
  }
}
console.log(`已 vendor ${THREE_BUILDS.length} 个 three 构建到 public/engine/core/（three@${threeVersion}）`);
