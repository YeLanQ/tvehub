// 微信 bundle 冒烟：node 下以最小浏览器存根 require 产物 code.js——验证 CJS
// 形态可加载（无存活 import/export/动态 import）、__tveFacade 门面导出可达；
// 物理引擎产物（rapier/jolt/ammo CJS 预转换）额外验证可加载并导出工厂。
// isWechatRuntime=false 时适配层整体空转；player 的 main() 在首个 await 处挂起，
// 进程随即退出，不产生副作用。
"use strict";

const codePath = process.argv[2];
if (!codePath) {
  console.error("usage: node smoke.cjs <code.js> [physics-engine.js …]");
  process.exit(1);
}

/** 全局写入（node 22 的 navigator 等为只读全局，defineProperty 覆盖，失败即跳过） */
function stubGlobal(name, value) {
  try {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  } catch {
    /* 已存在且不可配置 → 保留原生 */
  }
}

stubGlobal("document", {
  getElementById: () => null,
  createElement: () => ({ style: {}, appendChild() {}, addEventListener() {}, querySelector: () => null }),
  createElementNS: () => ({ style: {}, addEventListener() {} }),
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  documentElement: {},
  body: {},
  hidden: false,
  visibilityState: "visible",
  baseURI: "https://tve.local/game.js",
});
stubGlobal("location", {
  href: "https://tve.local/game.js",
  origin: "https://tve.local",
  protocol: "https:",
  pathname: "/game.js",
  search: "",
  hash: "",
});
stubGlobal("navigator", { userAgent: "wechat-smoke", platform: "smoke" });
stubGlobal("window", {
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  innerWidth: 375,
  innerHeight: 667,
  devicePixelRatio: 2,
  location: null,
});
globalThis.window.location = globalThis.location;
globalThis.window.parent = globalThis.window;
globalThis.window.self = globalThis.window;
stubGlobal("self", globalThis.window);
globalThis.performance = globalThis.performance || { now: () => Date.now() };
stubGlobal("requestAnimationFrame", (fn) => setTimeout(() => fn(Date.now()), 16));
stubGlobal("cancelAnimationFrame", (id) => clearTimeout(id));
// fetch 相对地址必败 → main() 在可挂起态被进程退出截断
stubGlobal("fetch", () => Promise.reject(new TypeError("smoke: fetch disabled")));

let mod;
try {
  // 以脚本模式求值（微信对包内文件按裸包装脚本装载，vm Script 语义最接近；
  // 仓库 package.json 的 type:module 会让 require 把 .js 当 ESM，故不走 require）
  const fs = require("node:fs");
  const vm = require("node:vm");
  const loadAsCjs = (filePath) => {
    const text = fs.readFileSync(filePath, "utf8");
    const wrapper = vm.runInThisContext(
      `(function (exports, require, module, __filename, __dirname) {\n${text}\n})`,
      { filename: filePath },
    );
    const module_ = { exports: {} };
    const realRequire = require("node:module").createRequire(filePath);
    const requireFromBundle = (spec) => {
      // data.js 由导出期生成，构建冒烟以桩数据代替（形态校验走 data-bridge 的容错）
      if (spec === "./data.js") return { config: {}, assets: {} };
      return realRequire(spec);
    };
    wrapper(module_.exports, requireFromBundle, module_, filePath, require("node:path").dirname(filePath));
    return module_.exports;
  };
  mod = loadAsCjs(codePath);

  // 物理引擎产物：可加载 + 暴露引擎工厂（rapier = default.init 对象、jolt =
  // default 工厂函数、ammo = initAmmo 命名导出）
  const engineFiles = process.argv.slice(3);
  for (const enginePath of engineFiles) {
    const engineMod = loadAsCjs(enginePath);
    const d = engineMod.default;
    const shape =
      typeof d === "function" ? "default()" :
      d && typeof d.init === "function" ? "default.init()" :
      typeof engineMod.initAmmo === "function" ? "initAmmo()" : null;
    if (!shape) {
      console.error(`[wechat-smoke] 物理引擎产物无工厂导出: ${enginePath} (${Object.keys(engineMod).slice(0, 6)})`);
      process.exit(4);
    }
    console.log(`[wechat-smoke] engine ok: ${require("node:path").basename(enginePath)}（exports ${shape}）`);
  }
} catch (e) {
  console.error("[wechat-smoke] 加载失败:", e && (e.stack || e.message || e));
  process.exit(2);
}

const facade = mod && mod.__tveFacade;
if (!facade || typeof facade !== "object" || !facade.engine || typeof facade.Component !== "function") {
  console.error("[wechat-smoke] __tveFacade 门面缺失或形态异常:", facade && Object.keys(facade).slice(0, 8));
  process.exit(3);
}

console.log(`[wechat-smoke] ok: bundle 加载成功，tve 门面导出 ${Object.keys(facade).length} 项`);
process.exit(0);
