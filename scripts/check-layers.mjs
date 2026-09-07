// 分层守卫：全仓只有 src/lib/ 允许直接 import @tauri-apps/api/core（Tauri invoke）。
// 组件 / store / app-lib 的 IPC 调用必须经 lib/api.ts、lib/scene-api.ts 门面，
// 便于统一命令参数命名、类型与后续 Rust 命令下沉。构建前执行：
//   node scripts/check-layers.mjs
// 用法：npm run check:layers

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const coreRef = /@tauri-apps\/api\/core/;

/** src/lib 下允许直接使用 core（数据层门面本身） */
function isDataLayer(file) {
  const rel = file.replace(/\\/g, "/").replace(srcDir.replace(/\\/g, "/"), "");
  return rel.startsWith("/lib/") || rel === "/lib";
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (/\.(ts|tsx|js|vue)$/.test(name)) {
      yield full;
    }
  }
}

const violations = [];
for (const file of walk(srcDir)) {
  if (isDataLayer(file)) continue;
  const text = readFileSync(file, "utf8");
  const lineNo = [];
  text.split("\n").forEach((ln, i) => {
    // 覆盖 import … from / import( … / require( … 三种写法
    if (coreRef.test(ln) && !ln.trim().startsWith("//")) lineNo.push(i + 1);
  });
  for (const n of lineNo) {
    violations.push(`${file.replace(root + sep, "")}:${n}`);
  }
}

if (violations.length) {
  console.error(
    "[check-layers] 分层守卫失败：以下文件直接引用了 @tauri-apps/api/core（只允许 src/lib/）。\n" +
      "请改用 src/lib/api.ts / src/lib/scene-api.ts 门面。\n  " +
      violations.join("\n  "),
  );
  process.exit(1);
}
console.log("[check-layers] 通过：src 下无 lib 之外的 @tauri-apps/api/core 引用");
