// ammo.js（Bullet Physics）ESM 初始化器：把 UMD 胶水还原为工厂并实例化 wasm。
// wasm 文件化：经全局钩子 __tveInstantiateWasmFile(path, imports) 加载同目录
// ammo.wasm（构建期由 ammo-wasm-b64.mjs 抽取落盘，不再内联）。web 播放器主线程/
// Worker 与编辑器 canvas 各自安装该钩子，微信渠道由桥接垫片安装（WXWebAssembly
// 包内路径直连），单页模式被资产 fetch 垫片命中——契约见
// src/framework/physics/wasm-file-hook.ts。
// （由 scripts/make-ammo-esm.cjs 生成，升级 ammo 时重跑该脚本同步此模板）
import AMMO_GLUE from "./ammo-glue.mjs";

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
