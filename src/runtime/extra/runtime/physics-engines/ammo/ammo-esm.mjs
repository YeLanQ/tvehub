// ammo.js（Bullet Physics）ESM 初始化器：把 UMD 胶水还原为工厂并实例化 wasm。
// 双路径：微信渠道（构建期 define __TVE_WECHAT__，esbuild 消除另一分支）经桥接层
// 钩子 __tveInstantiateWasmFile 以包内 .wasm 路径直连 WXWebAssembly（基础库只认
// 包内文件路径）；web/单页走 base64 内联 wasmBinary，无外部文件依赖。
// （由 scripts/make-ammo-esm.cjs 生成，升级 ammo 时重跑该脚本同步此模板）
import AMMO_GLUE from "./ammo-glue.mjs";
import AMMO_WASM_B64 from "./ammo-wasm-b64.mjs";

let cached = null;

/** 初始化并返回 ammo 模块（幂等） */
export function initAmmo() {
  if (cached) return cached;
  const factory = new Function(
    AMMO_GLUE + "\n;return typeof Ammo === 'function' ? Ammo : undefined;",
  )();
  if (typeof factory !== "function") {
    return Promise.reject(new Error("ammo 胶水未暴露 Ammo 工厂"));
  }
  if (typeof __TVE_WECHAT__ !== "undefined" && __TVE_WECHAT__) {
    cached = Promise.resolve(
      factory({
        instantiateWasm(imports, receiveInstance) {
          return globalThis
            .__tveInstantiateWasmFile("engine/runtime/physics-engines/ammo/ammo.wasm", imports)
            .then((res) => {
              receiveInstance(res.instance, res.module);
              return res.instance && res.instance.exports;
            });
        },
      }),
    );
    return cached;
  }
  const bin = atob(AMMO_WASM_B64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  cached = Promise.resolve(factory({ wasmBinary: bytes }));
  return cached;
}
