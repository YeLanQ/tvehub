// ---------------------------------------------------------------------------
// smoke 公共套件库：断言计数、统一输出、DOM 垫片、运行时模块加载器。
// 全部 smoke-* 脚本共用；.mjs 直跑与 vite --ssr 打包两条路径均可用。
//
// 约定（统一入口 runner.mjs 依赖）：
// - 套件结尾调用 finish()，统一打印「结果：X 通过，Y 失败」——runner 靠这行
//   解析每个套件的断言数，exitCode 非 0 视为套件失败；
// - 仓库根解析不依赖 import.meta（.ts 脚本打包后位置会变）：优先
//   TVE_SMOKE_ROOT（统一入口注入），否则从 cwd 向上找 package.json。
// ---------------------------------------------------------------------------
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function findRepoRoot(start = process.cwd()) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start); // 顶到盘根仍未找到：退回起点
    dir = parent;
  }
}

export const ROOT = process.env.TVE_SMOKE_ROOT
  ? resolve(process.env.TVE_SMOKE_ROOT)
  : findRepoRoot();

const engineFileURL = (...seg) => pathToFileURL(join(ROOT, "public", "engine", ...seg)).href;

/** 运行时模块加载 URL，如 engineURL("runtime/stage.mjs") */
export const engineURL = (rel) => engineFileURL(rel);
export const runtimeURL = (rel) => engineFileURL("runtime", rel);
export const coreURL = (rel) => engineFileURL("core", rel);

/**
 * 最小 DOM 垫片：部分运行时模块在导入期访问 window/document（事件监听、兼容分支）。
 * 需要更多桩的脚本（canvas、事件注册表、baseURI 等）在调用本函数后自行补充。
 */
export function installDomShim() {
  globalThis.window ??= globalThis;
  globalThis.window.addEventListener ??= () => {};
  globalThis.window.removeEventListener ??= () => {};
  globalThis.document ??= { createElement: () => ({ style: {}, getContext: () => null }) };
  globalThis.self ??= globalThis;
}

/** 数值近似比较 */
export function approx(a, b, eps = 1e-3) {
  return Math.abs(a - b) <= eps;
}

/**
 * 创建一个冒烟套件：断言计数 + 统一输出。
 * - ok(cond, label)：逐条输出 ✓/✗
 * - okQuiet(cond, label)：仅失败时输出（断言很多的套件保持输出紧凑）
 * - check(name, cond, detail)：同 ok，失败时追加 detail 说明
 * - counts()：随时读取当前计数（供套件中途打印进度）
 * - finish()：结尾统一打印「结果：X 通过，Y 失败」并设置退出码
 */
export function createSuite() {
  let passed = 0;
  let failed = 0;

  function ok(cond, label) {
    if (cond) {
      passed++;
      console.log(`  ✓ ${label}`);
    } else {
      failed++;
      console.error(`  ✗ ${label}`);
    }
  }

  function okQuiet(cond, label) {
    if (cond) {
      passed++;
    } else {
      failed++;
      console.error(`  ✗ ${label}`);
    }
  }

  function check(name, cond, detail = "") {
    if (cond) {
      passed++;
      console.log(`  ✓ ${name}`);
    } else {
      failed++;
      console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    }
  }

  function counts() {
    return { passed, failed };
  }

  function finish() {
    console.log(`\n结果：${passed} 通过，${failed} 失败`);
    process.exitCode = failed > 0 ? 1 : 0;
    return { passed, failed };
  }

  return { ok, okQuiet, check, counts, finish, approx };
}
