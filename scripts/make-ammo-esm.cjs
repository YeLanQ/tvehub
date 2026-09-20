// 生成 ammo.js 的 ESM 包装模块（升级脚本，不在构建链上）：
// - ammo-glue.mjs      ：ammo.wasm.js 胶水源码作为默认导出字符串（随模块图内联/落盘）
// - ammo-wasm-b64.mjs  ：ammo.wasm.wasm 的 base64 字符串
// - ammo-esm.mjs       ：初始化器（new Function 还原工厂 + wasmBinary 注入，免运行时取 .wasm）
// 升级流程：把上游 ammo.wasm.js / ammo.wasm.wasm 放入输出目录 → 跑本脚本（生成三件套
// 并删除原始文件）→ build-runtime.mjs 会把三件套从 extra 拷进 public/engine。
// 用法：node scripts/make-ammo-esm.cjs
const fs = require("fs");
const path = require("path");

// 单一事实源 = src/runtime/extra（入库）；public/engine 侧副本不入库、构建期自动拷出
const dir = path.join(
  __dirname,
  "..",
  "src",
  "runtime",
  "extra",
  "runtime",
  "physics-engines",
  "ammo",
);
const glue = fs.readFileSync(path.join(dir, "ammo.wasm.js"), "utf8");
const wasm = fs.readFileSync(path.join(dir, "ammo.wasm.wasm"));

fs.writeFileSync(
  path.join(dir, "ammo-glue.mjs"),
  "// 由 scripts/make-ammo-esm.mjs 生成：ammo.js 胶水源码（kripken/ammo.js，zlib License）\n" +
    "export default " +
    JSON.stringify(glue) +
    ";\n",
);

fs.writeFileSync(
  path.join(dir, "ammo-wasm-b64.mjs"),
  "// 由 scripts/make-ammo-esm.mjs 生成：ammo.wasm.wasm 的 base64（运行时经 wasmBinary 注入）\n" +
    'export default "' +
    wasm.toString("base64") +
    '";\n',
);

fs.writeFileSync(
  path.join(dir, "ammo-esm.mjs"),
  `// ammo.js（Bullet Physics）ESM 初始化器：把 UMD 胶水还原为工厂并注入 wasmBinary，
// 免去运行时按脚本目录取 ammo.wasm.wasm（单页内联/多文件产物均可加载）。
import AMMO_GLUE from "./ammo-glue.mjs";
import AMMO_WASM_B64 from "./ammo-wasm-b64.mjs";

let cached = null;

/** 初始化并返回 ammo 模块（幂等；wasm 以 base64 内联，无外部文件依赖） */
export function initAmmo() {
  if (cached) return cached;
  const factory = new Function(
    AMMO_GLUE + "\\n;return typeof Ammo === 'function' ? Ammo : undefined;",
  )();
  if (typeof factory !== "function") {
    return Promise.reject(new Error("ammo 胶水未暴露 Ammo 工厂"));
  }
  const bin = atob(AMMO_WASM_B64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  cached = Promise.resolve(factory({ wasmBinary: bytes }));
  return cached;
}
`,
);

// 原始 UMD 胶水与 wasm 二进制不再需要（编辑器/播放器统一走 ESM 包装）
fs.unlinkSync(path.join(dir, "ammo.wasm.js"));
fs.unlinkSync(path.join(dir, "ammo.wasm.wasm"));
console.log("ammo ESM wrapper generated");
