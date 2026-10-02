// 桥接核心 · WebAssembly 垫片：真机小游戏没有标准 WebAssembly 全局（只有平台
// 实现如 WXWebAssembly，且开发者工具子上下文给的是缺成员的残缺对象），而物理
// 引擎产物（rapier/jolt/ammo）与 meshopt 解码器统一经 WebAssembly.* 消费。
// 垫片把 instantiate 委托给平台端点的 instantiateWasm（平台 API 全部收敛在
// platforms/<id>.ts，核心不触平台形态）。
//
// 安装策略：平台对象完整（instantiate/validate/Module/Instance/Memory 齐）不装；
// 全缺位装整套；残缺（部分成员）做成员级修补——instantiate/instantiateStreaming
// 强制切到端点链路（引擎传字节，端点负责平台形态），其余 fill-if-absent。

import { bridgeActive, host } from "./host.ts";
import { setGlobal } from "./install.ts";
import { bridgeLog } from "./log.ts";

/**
 * 组装 WebAssembly 垫片（纯函数，便于契约测试）。
 * @param {Function} instantiateWasm 平台端点的 instantiateWasm(bytes, imports)
 */
export function buildWasmShim(instantiateWasm) {
  // 兼容 Error 子类：emscripten/jolt 在 abort 路径无条件 new WebAssembly.RuntimeError
  class RuntimeError extends Error {}
  class CompileError extends Error {}
  class LinkError extends Error {}
  // wasm-bindgen 对 instantiate 结果做 `x instanceof WebAssembly.Instance` 分支
  // 判定：结果对象不会是本桩的实例（走 {module, instance} 分支），构造器存在即可
  class Instance {}
  class Module {}
  return {
    instantiate(bytes, imports) {
      return instantiateWasm(bytes, imports);
    },
    // 流式形态仅 Response 入口可达（真机无 fetch wasm 场景）：读全量字节走同链路
    instantiateStreaming(source, imports) {
      return Promise.resolve(source)
        .then((r) => r.arrayBuffer())
        .then((buf) => instantiateWasm(buf, imports));
    },
    // validate：仅残缺平台会用到（完整原生不装垫片）。保守恒 false——唯一消费方
    // meshopt 解码器据此走非 SIMD 构建，全平台可实例化；SIMD 优化让位给可用性
    validate() {
      return false;
    },
    Instance,
    Module,
    RuntimeError,
    CompileError,
    LinkError,
  };
}

/** 平台 WebAssembly 完整性：核心成员齐备才视为完整原生（微信子上下文给的是
 *  残缺对象——有部分成员但缺 validate 等，存在性判断会被它骗过） */
export function isCompleteWebAssembly(existing) {
  if (!existing || typeof existing !== "object") return false;
  for (const key of ["instantiate", "validate", "Module", "Instance", "Memory"]) {
    if (typeof existing[key] === "undefined") return false;
  }
  return true;
}

/** 把垫片成员补进残缺的平台对象：instantiate 链路统一走端点（确定性契约），
 *  其余 fill-if-absent。对象不可扩展时整体换新（setGlobal 双写兜底）。
 *  @returns {boolean} 是否有成员生效 */
export function patchWasmGlobal(existing, shim) {
  const missing = [];
  for (const key of Object.keys(shim)) {
    const mustOverride = key === "instantiate" || key === "instantiateStreaming";
    if (!mustOverride && typeof existing[key] !== "undefined") continue;
    let done = false;
    try {
      Object.defineProperty(existing, key, { value: shim[key], writable: true, configurable: true });
      done = true;
    } catch {
      /* 不可扩展走整体换新 */
    }
    if (!done) {
      try {
        existing[key] = shim[key];
        done = true;
      } catch {
        /* 只读访问器 */
      }
    }
    if (!done) missing.push(key);
  }
  if (missing.length) {
    try {
      const merged = { ...existing };
      for (const key of Object.keys(shim)) merged[key] = shim[key];
      setGlobal("WebAssembly", merged);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

export function installWasmShim() {
  if (!bridgeActive()) return;
  const endpoint = host();
  const support = endpoint && endpoint.instantiateWasm;
  if (typeof support !== "function") return;
  const instantiateBound = support.bind(endpoint);

  // 包内路径实例化钩子（构建期改写的引擎胶水直连：rapier/jolt/ammo/meshopt）：
  // __tveInstantiateWasmFile(path, imports) → Promise<{module, instance}>
  setGlobal("__tveInstantiateWasmFile", (path, imports) => {
    const result = instantiateBound(path, imports);
    if (result === null) {
      return Promise.reject(new Error(`[runtime-bridge] 平台不支持 wasm 路径实例化: ${path}`));
    }
    return result;
  });

  let existing = null;
  try {
    existing = typeof globalThis.WebAssembly === "object" ? globalThis.WebAssembly : null;
  } catch {
    /* 沙箱遮蔽按缺位处理 */
  }
  if (isCompleteWebAssembly(existing)) return;
  const shim = buildWasmShim(instantiateBound);
  if (!existing) {
    setGlobal("WebAssembly", shim);
    bridgeLog("log", "[runtime-bridge] WebAssembly 垫片已安装（经平台端点 instantiateWasm 实例化）");
    return;
  }
  const added = Object.keys(shim).filter((k) => typeof existing[k] === "undefined");
  if (patchWasmGlobal(existing, shim)) {
    bridgeLog(
      "log",
      `[runtime-bridge] 平台 WebAssembly 残缺（缺 ${added.join(", ") || "—"}），已补齐并统一切换到端点 instantiateWasm 链路`,
    );
  } else {
    bridgeLog("warn", "[runtime-bridge] 平台 WebAssembly 残缺且不可修补，wasm 物理将不可用");
  }
}

// 求值期安装（bootstrap 以 import 装配，见该文件说明）
installWasmShim();
