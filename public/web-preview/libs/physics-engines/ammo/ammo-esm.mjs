// ammo.js（Bullet Physics）ESM 初始化器：把 UMD 胶水还原为工厂并注入 wasmBinary，
// 免去运行时按脚本目录取 ammo.wasm.wasm（单页内联/多文件产物均可加载）。
import AMMO_GLUE from "./ammo-glue.mjs";
import AMMO_WASM_B64 from "./ammo-wasm-b64.mjs";

let cached = null;

/** 初始化并返回 ammo 模块（幂等；wasm 以 base64 内联，无外部文件依赖） */
export function initAmmo() {
  if (cached) return cached;
  const factory = new Function(
    AMMO_GLUE + "\n;return typeof Ammo === 'function' ? Ammo : undefined;",
  )();
  if (typeof factory !== "function") {
    return Promise.reject(new Error("ammo 胶水未暴露 Ammo 工厂"));
  }
  const bin = atob(AMMO_WASM_B64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  cached = Promise.resolve(factory({ wasmBinary: bytes }));
  return cached;
}
