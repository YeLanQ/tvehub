// 桥接层契约（单一事实源）：渠道接入 = 实现 HostEndpoint 的平台端点；桥接核心
// 负责把端点能力装配成浏览器形态的全局。HOST_SURFACE/GLOBAL_SURFACE 均为机器
// 可校验数据——assertHost 在端点注册时校验实现完整性；check-surface.mjs 用
// GLOBAL_SURFACE 与覆盖清单对照统一运行时源码的全局用法（漂移守卫）。
// __tve* 钩子名等跨边界常量见 ./protocol.ts（运行时协议单源）。

import { TVE_BUILD_DATA, TVE_CREATE_WORKER, TVE_LOAD_MODULE } from "./protocol.ts";

/** 平台触摸事件的中性形态（端点负责从平台事件映射） */
export interface HostTouch {
  identifier: number;
  clientX: number;
  clientY: number;
}

/** 平台按键事件的中性形态 */
export interface HostKey {
  key: string;
  code: string;
  keyCode: number;
}

/** 平台视口（逻辑像素） */
export interface HostViewport {
  width: number;
  height: number;
  dpr: number;
}

/** WebAssembly.instantiate 的实例化结果（module/instance 与标准一致） */
export interface WasmInstantiateResult {
  module: unknown;
  instance: unknown;
}

/** 平台 Worker 的中性形态（worker.ts 的 ns 多路复用消费面；消息恒拷贝语义，
 *  下行以 onMessage 回调送达——回调参数可能是消息本体或 {data} 包装，消费方解包） */
export interface HostWorker {
  onMessage(cb: (msg: unknown) => void): void;
  postMessage(msg: unknown): void;
  terminate(): void;
}

/** 平台端点：渠道接入的唯一职责面（~24 方法；实现放在 platforms/<id>.ts） */
export interface HostEndpoint {
  platformId: string;
  /** 平台是否可用（wx 缺席等场景为 false → 桥接核心整体空转） */
  available(): boolean;
  /**
   * 实例化 wasm。两种来源形态：
   * - string：代码包内 .wasm 文件路径（构建期改写的引擎胶水直连），平台以
   *   原生路径形态实例化（微信 = WXWebAssembly.instantiate(path)）；
   * - ArrayBuffer | Uint8Array：引擎解码出的内嵌 wasm 字节（垫片兜底链：
   *   落盘用户目录 → 直传字节）。
   * 平台无法实例化时返回 null（垫片不安装/调用方降级）。
   */
  instantiateWasm(
    source: ArrayBuffer | Uint8Array | string,
    imports: unknown,
  ): Promise<WasmInstantiateResult> | null;
  /**
   * 读代码包内文件为字节（资产文件化：二进制资产按清单落盘，运行期经此读取）。
   * rel 为包内相对路径（如 "assets/<uid>.png"）。平台不支持/读取失败返回 null。
   */
  readPackageFile(rel: string): ArrayBuffer | null;
  /**
   * 创建平台 Worker（微信 = wx.createWorker；平台缺能力/创建失败返回 null）。
   * path 为包内 worker 入口（如 "workers/tve.js"，game.json 须声明 workers 字段）。
   * worker.ts 在其上做 ns 信封多路复用（wx 平台限额每包 1 个 Worker）。
   */
  createWorker(path: string): HostWorker | null;
  getViewport(): HostViewport;
  requestAnimationFrame(fn: (now: number) => void): number;
  cancelAnimationFrame(id: number): void;
  /** 屏上画布（整个包内仅桥接核心调用一次；首个平台画布即屏上画布） */
  createScreenCanvas(): unknown;
  /** 离屏 2D 画布，兜底链在端点内闭合；全链失败返回 null */
  createOffscreenCanvas(width: number, height: number): unknown | null;
  createImage(): unknown;
  /** 平台 WebAudio 上下文；不可用时返回 null（音频静音降级） */
  createAudioContext(): unknown | null;
  onTouchStart(handler: (touch: HostTouch) => void): void;
  onTouchMove(handler: (touch: HostTouch) => void): void;
  onTouchEnd(handler: (touch: HostTouch) => void): void;
  onTouchCancel(handler: (touch: HostTouch) => void): void;
  onKeyDown(handler: (key: HostKey) => void): void;
  onKeyUp(handler: (key: HostKey) => void): void;
  onShow(handler: () => void): void;
  onHide(handler: () => void): void;
  onWindowResize(handler: (size: { width: number; height: number }) => void): void;
  onError(handler: (message: string) => void): void;
  storageGet(key: string): string | null;
  storageSet(key: string, value: string): void;
  storageRemove(key: string): void;
}

/** 平台端点必须实现的方法（platformId 为字符串标识，其余均为函数） */
export const HOST_SURFACE: string[] = [
  "platformId",
  "available",
  "instantiateWasm",
  "readPackageFile",
  "createWorker",
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

/** 桥接核心安装到全局的名字（check-surface.mjs 的覆盖依据之一） */
export const GLOBAL_SURFACE: string[] = [
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
  TVE_LOAD_MODULE,
  TVE_BUILD_DATA,
  TVE_CREATE_WORKER,
];

/** 端点完整性校验：缺方法/类型不符时抛出带方法名的明确错误（注册期即失败，
 *  不等设备上首用才暴露） */
export function assertHost(host: HostEndpoint | null): HostEndpoint {
  const candidate = host as unknown as Record<string, unknown> | null;
  const missing = HOST_SURFACE.filter((key) => {
    if (key === "platformId") return typeof candidate?.[key] !== "string";
    return typeof candidate?.[key] !== "function";
  });
  if (missing.length) {
    throw new Error(`[runtime-bridge] 平台端点实现不完整，缺少: ${missing.join(", ")}`);
  }
  return host as HostEndpoint;
}
