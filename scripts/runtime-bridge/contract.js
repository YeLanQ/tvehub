// 桥接层契约（单一事实源）：渠道接入 = 实现 HOST_SURFACE 的平台端点；桥接核心
// 负责把端点能力装配成浏览器形态的全局。两份清单均为机器可校验数据——
// assertHost 在端点注册时校验实现完整性；check-surface.mjs 用 GLOBAL_SURFACE
// 与覆盖清单对照统一运行时源码的全局用法（漂移守卫）。

/** 平台端点必须实现的方法（platformId 为字符串标识，其余均为函数） */
export const HOST_SURFACE = [
  "platformId",
  "available",
  "getViewport",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "createScreenCanvas",
  "createOffscreenCanvas",
  "createImage",
  "createAudioContext",
  "onTouchStart",
  "onTouchMove",
  "onTouchEnd",
  "onTouchCancel",
  "onKeyDown",
  "onKeyUp",
  "onShow",
  "onHide",
  "onWindowResize",
  "onError",
  "storageGet",
  "storageSet",
  "storageRemove",
];

/** 桥接核心安装到全局的名字（check-surface 的覆盖依据之一） */
export const GLOBAL_SURFACE = [
  "window",
  "document",
  "location",
  "navigator",
  "self",
  "parent",
  "top",
  "performance",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "fetch",
  "URL",
  "URLSearchParams",
  "localStorage",
  "TextEncoder",
  "TextDecoder",
  "btoa",
  "atob",
  "Blob",
  "Headers",
  "Response",
  "Request",
  "AbortController",
  "AbortSignal",
  "Image",
  "createImageBitmap",
  "AudioContext",
  "webkitAudioContext",
  "__tveLoadModule",
  "__TVE_BUILD_DATA",
];

/** 端点完整性校验：缺方法/类型不符时抛出带方法名的明确错误（注册期即失败，
 *  不等设备上首用才暴露） */
export function assertHost(host) {
  const missing = HOST_SURFACE.filter((key) => {
    if (key === "platformId") return typeof host?.[key] !== "string";
    return typeof host?.[key] !== "function";
  });
  if (missing.length) {
    throw new Error(`[runtime-bridge] 平台端点实现不完整，缺少: ${missing.join(", ")}`);
  }
  return host;
}
