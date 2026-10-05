// 微信 bundle · 守卫与工程文件：构建链三道子进程守卫（surface 漂移守卫 /
// bridge 契约测试 / bundle 冒烟）+ tve 门面生成。三个守卫也有独立 npm script
// （pnpm check:surface / pnpm test:bridge；冒烟依赖产物，仅在构建链内跑）。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { BRIDGE_DIR, WECHAT_RUNTIME_DIR } from "../lib/paths.mjs";
import { TVE_FACADE } from "../../bridge/protocol.ts";
import { PHYSICS_ENGINES } from "./engines.mjs";

/** 漂移守卫：统一运行时源码的全局用法对照桥接覆盖清单（未覆盖新增 = 构建失败） */
export function runSurfaceCheck() {
  execFileSync(process.execPath, [path.join(BRIDGE_DIR, "check-surface.mjs")], {
    stdio: "inherit",
    timeout: 60_000,
  });
}

/** 契约一致性测试：桥接核心语义 + 平台端点（实验室判定集固化，见 bridge.spec.mjs） */
export function runBridgeSpec() {
  execFileSync(process.execPath, [path.join(BRIDGE_DIR, "bridge.spec.mjs")], {
    stdio: "inherit",
    timeout: 120_000,
  });
}

/** node 冒烟：最小存根下 require 产物（CJS 形态 + tve 门面可达性 + 物理引擎可加载） */
export function smokeRequireBundle(engineSizes) {
  const smoke = path.join(BRIDGE_DIR, "smoke.cjs");
  const engineFiles = PHYSICS_ENGINES.filter((def) => engineSizes[def.key] !== undefined).map(
    (def) => path.join(WECHAT_RUNTIME_DIR, def.out),
  );
  execFileSync(
    process.execPath,
    [smoke, path.join(WECHAT_RUNTIME_DIR, "code.js"), ...engineFiles],
    { stdio: "inherit", timeout: 120_000 },
  );
}

/** tve 门面：转发主 bundle 的命名空间导出（用户脚本 require "../../engine/core/tve.js"） */
export function writeTveFacade() {
  const facade =
    "// 由 runtime/scripts/wechat.mjs 生成（请勿手动编辑）：\n" +
    `// 用户脚本 tve 门面——转发主 bundle 的 ${TVE_FACADE}（= engine/core/tve.mjs 全部导出）。\n` +
    '"use strict";\n' +
    'var facade = require("../../code.js");\n' +
    `module.exports = (facade && facade.${TVE_FACADE}) || {};\n`;
  const file = path.join(WECHAT_RUNTIME_DIR, "engine/core/tve.js");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, facade);
  return Buffer.byteLength(facade);
}
