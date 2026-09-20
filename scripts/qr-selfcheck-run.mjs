// ---------------------------------------------------------------------------
// 二维码自检的启动器：清产物目录 → vite --ssr 打包 → 跑自检。
// 单独写一个脚本而不是把三步串在 package.json 里，是为了避免跨平台 shell 引号问题，
// 也保证「构建失败就不能跑到上一次的旧产物」（否则会出现假绿）。
// 运行：npm run qr:check
// ---------------------------------------------------------------------------
import { rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, ".tmp-qrcheck", "out");

rmSync(outDir, { recursive: true, force: true });

// 直接跑 vite 的 JS 入口（而非 npx/.bin 包装脚本）：Windows 上 Node 不允许
// 无 shell 地 spawn .cmd/.bat，走 node + bin/vite.js 跨平台且没有引号烦恼
const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");
const build = spawnSync(
  process.execPath,
  [viteBin, "build", "--ssr", "scripts/qr-selfcheck.ts", "--outDir", ".tmp-qrcheck/out", "--emptyOutDir"],
  { cwd: root, stdio: "inherit" },
);
if (build.error) {
  console.error(`[qr:check] 无法启动 vite: ${build.error.message}`);
  process.exit(1);
}
if (build.status !== 0) {
  console.error("[qr:check] 自检脚本构建失败，未运行（上面的报错按 TS/打包问题处理）");
  process.exit(build.status ?? 1);
}

const entry = join(outDir, "qr-selfcheck.js");
if (!existsSync(entry)) {
  console.error(`[qr:check] 未生成 ${entry}，视为构建异常`);
  process.exit(1);
}
const run = spawnSync(process.execPath, [entry], { cwd: root, stdio: "inherit" });
process.exit(run.status ?? 1);
