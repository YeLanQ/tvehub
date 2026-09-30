// 桥接核心 · 用户脚本动态加载：bundle 构建期已把 scripts.mjs 的动态 import(spec)
// 改写为 __tveLoadModule(spec)（引擎源零改动）。此处实现 spec → 包内 require：
// 剥 tve: 前缀（scripts.ts 对内联数据形态恒发 tve:<rel>）、小写折叠（开发者工具
// 包内注册表小写归一）、补 ./ 前缀（微信 require 需显式相对形态）。

import { bridgeActive } from "./host.js";
import { setGlobal } from "./install.js";

function normalizeSpec(spec) {
  let rel = String(spec ?? "").replace(/\\/g, "/");
  if (rel.startsWith("tve:")) rel = rel.slice(4);
  rel = rel.toLowerCase();
  if (!rel.startsWith("./") && !rel.startsWith("../")) rel = `./${rel}`;
  return rel;
}

function loadModule(spec) {
  return Promise.resolve(require(normalizeSpec(spec)));
}

export function installLoadModule() {
  if (!bridgeActive()) return;
  setGlobal("__tveLoadModule", loadModule);
}

// 求值期安装（bootstrap 以 import 装配，见该文件说明）
installLoadModule();
