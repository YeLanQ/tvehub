// ---------------------------------------------------------------------------
// 把 three 的模型加载器（GLTF/FBX/OBJ）及其依赖 vendor 进网页预览运行时
// public/engine/runtime/loaders/（离线可用；与手动 vendor 的
// three.module.min.js / three.core.min.js 同一套来源）。
//
// 用法：node scripts/vendor-preview-loaders.mjs
// 升级 three 后重跑即可同步；若上游出现新的未知 import 会直接报错退出，
// 避免静默产出缺依赖的文件。
// ---------------------------------------------------------------------------
import { copyFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const threeDir = join(root, "node_modules", "three");
const outDir = join(root, "public", "engine", "runtime", "loaders");

const threeVersion = JSON.parse(readFileSync(join(threeDir, "package.json"), "utf8")).version;

// 源路径（相对 examples/jsm）→ 目标文件名 + 相对 import 重写规则
const FILES = [
  { src: "loaders/GLTFLoader.js", rewrites: { "../utils/BufferGeometryUtils.js": "./BufferGeometryUtils.js", "../utils/SkeletonUtils.js": "./SkeletonUtils.js" } },
  { src: "loaders/FBXLoader.js", rewrites: { "../libs/fflate.module.js": "./fflate.module.js", "../curves/NURBSCurve.js": "./NURBSCurve.js" } },
  { src: "loaders/OBJLoader.js", rewrites: {} },
  { src: "utils/SkeletonUtils.js", rewrites: {} },
  { src: "utils/BufferGeometryUtils.js", rewrites: {} },
  { src: "libs/fflate.module.js", rewrites: {} },
  { src: "curves/NURBSCurve.js", rewrites: { "../curves/NURBSUtils.js": "./NURBSUtils.js" } },
  { src: "curves/NURBSUtils.js", rewrites: {} },
];

const header = (src) =>
  `// Vendored from three@${threeVersion} examples/jsm/${src}\n` +
  `// 由 scripts/vendor-preview-loaders.mjs 生成（import 已重写指向预览运行时本地文件），请勿手改。\n`;

mkdirSync(outDir, { recursive: true });
const rewritten = [];
for (const { src, rewrites } of FILES) {
  const from = join(threeDir, "examples", "jsm", src);
  let text = readFileSync(from, "utf8");
  // three 裸导入（含多行 import 块结尾的 "} from 'three';"）→ 本地 three 运行时
  text = text.replace(/from\s+'three';/g, "from '../../core/three.module.min.js';");
  for (const [fromRel, toRel] of Object.entries(rewrites)) {
    text = text.split(`from '${fromRel}'`).join(`from '${toRel}'`);
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
