// 桥接核心 · 用户脚本动态加载：bundle 构建期已把 scripts.mjs 的动态 import(spec)
// 改写为 __tveLoadModule(spec)（引擎源零改动）。此处实现 spec → 包内 require：
// 剥 tve: 前缀（scripts.ts 对内联数据形态恒发 tve:<rel>）、小写折叠（开发者工具
// 包内注册表小写归一）、补 ./ 前缀（微信 require 需显式相对形态）。
// 钩子名与前缀取自 ./protocol.ts（构建脚本改写侧同一事实源）。

import { bridgeActive } from "./host.ts";
import { setGlobal } from "./install.ts";
import { TVE_LOAD_MODULE, TVE_SPEC_PREFIX } from "./protocol.ts";

/** bundle 运行域的 CJS require（esbuild CJS 产物包装器注入；类型层仅此消费面） */
declare const require: (id: string) => unknown;

function normalizeSpec(spec: unknown): string {
  let rel = String(spec ?? "").replace(/\\/g, "/");
  if (rel.startsWith(TVE_SPEC_PREFIX)) rel = rel.slice(TVE_SPEC_PREFIX.length);
  rel = rel.toLowerCase();
  if (!rel.startsWith("./") && !rel.startsWith("../")) rel = `./${rel}`;
  return rel;
}

function loadModule(spec: unknown): Promise<unknown> {
  return Promise.resolve(require(normalizeSpec(spec)));
}

export function installLoadModule(): void {
  if (!bridgeActive()) return;
  setGlobal(TVE_LOAD_MODULE, loadModule);
}

// 求值期安装（bootstrap 以 import 装配，见该文件说明）
installLoadModule();
