// 微信平台端点：HOST_SURFACE 的唯一 wx 实现处——全部 wx.* 调用收敛于此文件。
// 未来渠道（抖音小游戏 / 原生壳等）= 平级新增 platforms/<id>.js，桥接核心零改动。
// 方法契约（供核心消费的中性形态）：
// - getViewport() → { width, height, dpr }（逻辑像素）
// - onTouch*(handler) → handler(touch, changedCount)，touch = {identifier, clientX, clientY}
// - onKey*(handler) → handler({ key, code, keyCode })
// - onWindowResize(handler) → handler({ width, height })
// - onError(handler) → handler(message: string)
// - createOffscreenCanvas(w, h) → 离屏画布或 null（兜底链在本端点内闭合）

import { setHost } from "../host.ts";
import { bridgeLog } from "../log.ts";
import { assertHost, type HostEndpoint, type HostKey, type HostTouch, type HostViewport, type HostWorker, type WasmInstantiateResult } from "../contract.ts";

/** 文件系统管理器鸭子形态（读包/写用户目录/存在性预检；真机缺成员逐个可选） */
interface WxFileSystemManager {
  readFileSync?(path: string): ArrayBuffer;
  writeFileSync(path: string, data: ArrayBuffer, encoding: string): void;
  accessSync?(path: string): void;
}

/** 平台触摸事件原始形态（字段真机多形态，逐键容错） */
interface WxTouchEventLike {
  identifier?: number | string;
  id?: number | string;
  clientX?: number;
  clientY?: number;
  touches?: WxTouchEventLike[];
  changedTouches?: WxTouchEventLike[];
}

/** 平台按键事件原始形态（key/text 双字段为真机差异） */
interface WxKeyEventLike {
  key?: string;
  text?: string;
  code?: string;
  keyCode?: number;
}

/** wx.createWorker 原始返回形态（onMessage 单槽位——后注册覆盖前者） */
interface WxRawWorker {
  onMessage(cb: (msg: unknown) => void): void;
  postMessage(msg: unknown): void;
  terminate(): void;
}

/** wx 全局鸭子形态（只收敛本端点消费面；缺能力成员全部可选） */
interface WxLike {
  env?: { USER_DATA_PATH?: string };
  getSystemInfoSync?(): {
    windowWidth?: number;
    windowHeight?: number;
    pixelRatio?: number;
    devicePixelRatio?: number;
  } | null;
  createCanvas(): unknown;
  createOffscreenCanvas?(opts?: { type?: string; width?: number; height?: number }): unknown;
  createImage?(): unknown;
  createWebAudioContext?(): unknown;
  createInnerAudioContext?(): unknown;
  setInnerAudioOption?(opts: { obeyMuteSwitch?: boolean }): void;
  showModal?(opts: { title?: string; content?: string; showCancel?: boolean }): void;
  getFileSystemManager?(): WxFileSystemManager;
  createWorker?(path: string): WxRawWorker;
  requestAnimationFrame?(fn: (now: number) => void): number;
  cancelAnimationFrame?(id: number): void;
  onTouchStart?(cb: (res: WxTouchEventLike) => void): void;
  onTouchMove?(cb: (res: WxTouchEventLike) => void): void;
  onTouchEnd?(cb: (res: WxTouchEventLike) => void): void;
  onTouchCancel?(cb: (res: WxTouchEventLike) => void): void;
  onKeyDown?(cb: (res: WxKeyEventLike) => void): void;
  onKeyUp?(cb: (res: WxKeyEventLike) => void): void;
  onShow?(cb: () => void): void;
  onHide?(cb: () => void): void;
  onWindowResize?(cb: (res: { width: number; height: number }) => void): void;
  onError?(cb: (message: unknown) => void): void;
  getStorageSync?(key: string): unknown;
  setStorageSync?(key: string, value: unknown): void;
  removeStorageSync?(key: string): void;
}

/** WXWebAssembly 鸭子形态（instantiate 首参只认包内/本地文件路径——字节形态需
 *  先落盘用户目录；新基础库兼容直传字节） */
interface WXWebAssemblyLike {
  instantiate?(
    pathOrBytes: string | ArrayBuffer,
    imports?: unknown,
  ): Promise<WasmInstantiateResult>;
}

declare const wx: WxLike | undefined;
declare const GameGlobal: { wx?: WxLike; WXWebAssembly?: WXWebAssemblyLike } | undefined;
declare const WXWebAssembly: WXWebAssemblyLike | undefined;

const wxApi: WxLike | null = (() => {
  try {
    if (typeof wx !== "undefined" && wx) return wx;
  } catch {
    /* 沙箱遮蔽时读 free 标识符可能抛错 */
  }
  try {
    if (typeof GameGlobal !== "undefined" && GameGlobal && GameGlobal.wx) return GameGlobal.wx;
  } catch {
    /* 同上 */
  }
  return null;
})();

// WXWebAssembly：真机小游戏唯一的 wasm 入口（标准 WebAssembly 全局缺位），
// instantiate 首参数只认包内/本地文件路径——字节形态需先落盘用户目录。
const wxWasm: WXWebAssemblyLike | null = (() => {
  try {
    if (typeof WXWebAssembly !== "undefined" && WXWebAssembly) return WXWebAssembly;
  } catch {
    /* 同上 */
  }
  try {
    if (typeof GameGlobal !== "undefined" && GameGlobal && GameGlobal.WXWebAssembly) {
      return GameGlobal.WXWebAssembly;
    }
  } catch {
    /* 同上 */
  }
  return null;
})();

/** 字节 → 稳定文件名哈希（FNV-1a，引擎版本不变则同名跳过重复写盘） */
function wasmFileHash(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let h = 0x811c9dc5;
  for (let i = 0; i < view.length; i++) {
    h ^= view[i];
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 字节归一为 ArrayBuffer（TypedArray 可能带 byteOffset，复制出独立缓冲） */
function toArrayBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return view.slice().buffer;
}

/**
 * 实例化 wasm：字节落盘用户目录 → WXWebAssembly.instantiate(path)。
 * 路径形态全基础库可用；目录缺失/写盘失败时回落直传字节（新基础库兼容），
 * 全链失败抛出（物理世界创建入口会把报错落到日志，游戏继续无物理运行）。
 */
async function instantiateWasmViaFile(
  bytes: ArrayBuffer | Uint8Array,
  imports: unknown,
): Promise<WasmInstantiateResult> {
  const buffer = toArrayBuffer(bytes);
  const dir = wxApi?.env?.USER_DATA_PATH;
  const fsm = wxApi && typeof wxApi.getFileSystemManager === "function" ? wxApi.getFileSystemManager() : null;
  if (dir && fsm && typeof fsm.writeFileSync === "function") {
    const path = `${dir}/tve-wasm-${wasmFileHash(new Uint8Array(buffer))}.wasm`;
    try {
      fsm.writeFileSync(path, buffer, "binary");
      return await (wxWasm as { instantiate: NonNullable<WXWebAssemblyLike["instantiate"]> }).instantiate(path, imports);
    } catch (e) {
      bridgeLog("warn", "[runtime-bridge] wasm 文件形态实例化失败，回落直传字节", e);
    }
  }
  return await (wxWasm as { instantiate: NonNullable<WXWebAssemblyLike["instantiate"]> }).instantiate(buffer, imports);
}

function readViewport(): HostViewport {
  try {
    const info = wxApi && typeof wxApi.getSystemInfoSync === "function" ? wxApi.getSystemInfoSync() || {} : {};
    const width = Number(info.windowWidth) > 0 ? Number(info.windowWidth) : 375;
    const height = Number(info.windowHeight) > 0 ? Number(info.windowHeight) : 667;
    const dpr = Number(info.pixelRatio || info.devicePixelRatio) > 0 ? Number(info.pixelRatio || info.devicePixelRatio) : 2;
    return { width, height, dpr };
  } catch {
    return { width: 375, height: 667, dpr: 2 };
  }
}

/** 微信端点实现（契约面 HostEndpoint + 非契约诊断/平台音频通道） */
interface WechatEndpoint extends HostEndpoint {
  /** 真机诊断弹窗（audio-diag 消费；wx.showModal 只在端点可达） */
  showDiagModal(text: unknown): void;
  /** InnerAudioContext 实例（2D 音源平台代管，audio-inner 消费） */
  createInnerAudio(): unknown | null;
  /** 全局音频选项（obeyMuteSwitch:false = iOS 静音键不拦游戏音频） */
  setInnerAudioOptions(opts: { obeyMuteSwitch?: boolean }): void;
  /** 字节落用户目录稳定名文件（内联音频资产的播放源） */
  writeUserFile(name: string, bytes: Uint8Array): string | null;
}

const wechatHost: WechatEndpoint = {
  platformId: "wechat",

  available(): boolean {
    return !!wxApi;
  },

  // wasm 实例化能力（桥接核心 WebAssembly 垫片的落地机制）：
  // - 包内路径形态（构建期改写的引擎胶水）：WXWebAssembly.instantiate(path) 直连
  //   ——基础库只认代码包内 .wasm/.wasm.br 文件路径（wxfile: 用户目录与字节直传
  //   均被拒，2026-10 工具实报）；WXWebAssembly 缺席时原生 WebAssembly 兜底
  //   （读包内文件为字节）。
  // - 字节形态（垫片兜底链）：落盘用户目录 → 直传字节。
  instantiateWasm(source: string | ArrayBuffer | Uint8Array, imports: unknown): Promise<WasmInstantiateResult> | null {
    if (typeof source === "string") {
      if (wxWasm && typeof wxWasm.instantiate === "function") {
        return wxWasm.instantiate(source, imports);
      }
      try {
        if (typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function") {
          const fsm = wxApi && typeof wxApi.getFileSystemManager === "function" ? wxApi.getFileSystemManager() : null;
          if (fsm && typeof fsm.readFileSync === "function") {
            const bytes = fsm.readFileSync(source);
            return WebAssembly.instantiate(bytes, imports as Parameters<typeof WebAssembly.instantiate>[1]);
          }
        }
      } catch {
        /* 读包文件失败按不支持 */
      }
      return null;
    }
    if (wxWasm && typeof wxWasm.instantiate === "function") {
      return instantiateWasmViaFile(source, imports);
    }
    try {
      if (typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function") {
        return WebAssembly.instantiate(toArrayBuffer(source), imports as Parameters<typeof WebAssembly.instantiate>[1]);
      }
    } catch {
      /* 沙箱遮蔽时读 free 标识符可能抛错 */
    }
    return null;
  },

  getViewport: readViewport,

  requestAnimationFrame(fn: (now: number) => void): number {
    if (wxApi && typeof wxApi.requestAnimationFrame === "function") {
      return wxApi.requestAnimationFrame(fn);
    }
    // rAF 缺失环境回退 16ms setTimeout
    return setTimeout(() => fn(Date.now()), 16);
  },

  cancelAnimationFrame(id: number): void {
    if (wxApi && typeof wxApi.cancelAnimationFrame === "function") {
      wxApi.cancelAnimationFrame(id);
      return;
    }
    clearTimeout(id);
  },

  // 首调 wx.createCanvas() 即屏上画布（整个包内仅核心 canvas 模块调用一次）
  createScreenCanvas(): unknown {
    return wxApi!.createCanvas();
  },

  // 离屏画布兜底链（全部 wx 侧形态）：createOffscreenCanvas({type:"2d"}) →
  // createOffscreenCanvas() → 二次 wx.createCanvas()（首画布已被屏上占用，
  // 二次得离屏）。全链失败返回 null，由核心决定末级兜底。
  createOffscreenCanvas(width: number, height: number): unknown | null {
    let canvas: unknown = null;
    try {
      if (typeof wxApi!.createOffscreenCanvas === "function") {
        canvas = wxApi!.createOffscreenCanvas!({ type: "2d", width, height });
      }
    } catch {
      canvas = null;
    }
    if (!canvas) {
      try {
        if (typeof wxApi!.createOffscreenCanvas === "function") {
          canvas = wxApi!.createOffscreenCanvas!();
        }
      } catch {
        canvas = null;
      }
    }
    if (!canvas) {
      try {
        canvas = wxApi!.createCanvas();
      } catch {
        canvas = null;
      }
    }
    return canvas;
  },

  createImage(): unknown {
    return wxApi!.createImage!();
  },

  createAudioContext(): unknown | null {
    try {
      if (typeof wxApi!.createWebAudioContext === "function") return wxApi!.createWebAudioContext();
    } catch (e) {
      bridgeLog("warn", "[runtime-bridge] WebAudio 创建失败（音频将静音）", e);
    }
    return null;
  },

  // 非契约诊断通道（音频诊断面 audio-diag 消费）：真机调试控制台不中继用户代码
  // console（10-07 实证），showModal 是唯一稳定读出面（层级高于进入页与游戏画面）。
  showDiagModal(text: unknown): void {
    try {
      if (typeof wxApi!.showModal === "function") {
        wxApi!.showModal!({ title: "TvE 诊断", content: String(text ?? ""), showCancel: false });
      }
    } catch {
      /* 诊断失败静默 */
    }
  },

  // —— 非契约平台音频（2D 音源代管 audio-inner.ts 消费面；其他端点可不实现）——

  /** InnerAudioContext 实例（真机可靠的媒体播放通路；缺能力返回 null） */
  createInnerAudio(): unknown | null {
    try {
      if (typeof wxApi!.createInnerAudioContext === "function") return wxApi!.createInnerAudioContext();
    } catch {
      /* 缺能力按 null（引擎回退 WebAudio 链） */
    }
    return null;
  },

  /** 全局音频选项（obeyMuteSwitch:false = iOS 静音键不拦游戏音频） */
  setInnerAudioOptions(opts: { obeyMuteSwitch?: boolean }): void {
    try {
      if (typeof wxApi!.setInnerAudioOption === "function") wxApi!.setInnerAudioOption!(opts);
    } catch {
      /* 选项失败按平台缺省 */
    }
  },

  /** 字节落用户目录稳定名文件（内联音频资产的播放源；失败返回 null） */
  writeUserFile(name: string, bytes: Uint8Array): string | null {
    try {
      const dir = wxApi?.env?.USER_DATA_PATH;
      const fsm = wxApi && typeof wxApi.getFileSystemManager === "function" ? wxApi.getFileSystemManager() : null;
      if (dir && fsm && typeof fsm.writeFileSync === "function") {
        const path = `${dir}/${String(name).replace(/[^\w.-]/g, "")}`;
        fsm.writeFileSync(path, bytes as unknown as ArrayBuffer, "binary");
        return path;
      }
    } catch {
      /* 写盘失败按 null（调用方回退） */
    }
    return null;
  },

  // 读代码包内文件为字节（资产文件化清单的落地机制）：readFileSync 无 encoding
  // 返回 ArrayBuffer，支持代码包相对路径；失败/不支持返回 null（调用方走缺失降级）。
  // byteLength duck-type 判定：instanceof 跨 realm（vm/多上下文）不可靠。
  readPackageFile(rel: string): ArrayBuffer | null {
    try {
      const fsm = wxApi && typeof wxApi.getFileSystemManager === "function" ? wxApi.getFileSystemManager() : null;
      if (fsm && typeof fsm.readFileSync === "function") {
        const bytes = fsm.readFileSync(rel);
        return bytes && typeof bytes.byteLength === "number" ? bytes : null;
      }
    } catch {
      /* 文件不存在/读取失败按缺失处理 */
    }
    return null;
  },

  // 平台 Worker（wx.createWorker；平台每包限额 1 个，ns 多路复用在 worker.ts）：
  // 缺能力/创建抛错一律 null（调用方回退主线程实现）。返回对象收敛为
  // HostWorker 中性形态（onMessage/postMessage/terminate），wx 特有方法不出平台层。
  createWorker(path: string): HostWorker | null {
    try {
      if (wxApi && typeof wxApi.createWorker === "function") {
        // 包内预检（缺失静默回退，真机错误行省一条）。accessSync 平台形态不一：
        // 部分平台对代码包相对路径恒抛 → 先用必然存在的 game.js 探测能力本身，
        // 探测不过 = 平台不支持 accessSync → 跳过预检，交由 createWorker 实证
        //（缺失时平台报错 + 抛错路径兜底）——不得让预检误杀随包 Worker。
        const fsm =
          wxApi && typeof wxApi.getFileSystemManager === "function" ? wxApi.getFileSystemManager() : null;
        if (fsm && typeof fsm.accessSync === "function") {
          let usable = false;
          try {
            fsm.accessSync("game.js");
            usable = true;
          } catch {
            usable = false;
          }
          if (usable) {
            try {
              fsm.accessSync(path);
            } catch {
              bridgeLog("warn", `[runtime-bridge] worker 入口预检缺失（${path}）→ 回退主线程`);
              return null;
            }
          } else {
            bridgeLog("warn", "[runtime-bridge] accessSync 不可用（跳过 worker 入口预检，交由 createWorker 实证）");
          }
        }
        const w: WxRawWorker | null = wxApi.createWorker(path);
        if (
          w &&
          typeof w.onMessage === "function" &&
          typeof w.postMessage === "function" &&
          typeof w.terminate === "function"
        ) {
          const worker = w;
          return {
            onMessage: (cb: (msg: unknown) => void): void => {
              try {
                worker.onMessage(cb);
              } catch (e) {
                bridgeLog("warn", "[runtime-bridge] worker.onMessage 注册失败", e);
              }
            },
            postMessage: (msg: unknown): void => {
              worker.postMessage(msg);
            },
            terminate: (): void => {
              try {
                worker.terminate();
              } catch {
                /* 平台已自灭按终止 */
              }
            },
          };
        }
        bridgeLog("warn", "[runtime-bridge] worker 形态不符（onMessage/postMessage/terminate 缺员）→ 回退主线程");
      }
    } catch (e) {
      bridgeLog("warn", "[runtime-bridge] 平台 createWorker 抛错（回退主线程）", e);
    }
    return null;
  },

  onTouchStart(handler: (touch: HostTouch) => void): void {
    bindTouch("onTouchStart", handler);
  },

  onTouchMove(handler: (touch: HostTouch) => void): void {
    bindTouch("onTouchMove", handler);
  },

  onTouchEnd(handler: (touch: HostTouch) => void): void {
    bindTouch("onTouchEnd", handler);
  },

  onTouchCancel(handler: (touch: HostTouch) => void): void {
    bindTouch("onTouchCancel", handler);
  },

  onKeyDown(handler: (key: HostKey) => void): void {
    bindKey("onKeyDown", handler);
  },

  onKeyUp(handler: (key: HostKey) => void): void {
    bindKey("onKeyUp", handler);
  },

  onShow(handler: () => void): void {
    if (typeof wxApi!.onShow === "function") {
      try {
        wxApi!.onShow!(() => handler());
      } catch {
        /* 生命周期注册失败忽略 */
      }
    }
  },

  onHide(handler: () => void): void {
    if (typeof wxApi!.onHide === "function") {
      try {
        wxApi!.onHide!(() => handler());
      } catch {
        /* 同上 */
      }
    }
  },

  onWindowResize(handler: (size: { width: number; height: number }) => void): void {
    if (typeof wxApi!.onWindowResize === "function") {
      try {
        // 视口真相由本端点守：game.json 锁定方向后视口恒等启动 sys 值，真机
        // 横屏 settle 期 onWindowResize 会报竖屏值（V7 读数实证），直接采信
        // 会把渲染缓冲拉成竖屏比例被平台拉伸上屏——事件仅作重新布局信号，
        // 值不采信（折叠屏展开等真实尺寸变化同样忽略，属既定取舍）
        const boot = readViewport();
        wxApi!.onWindowResize!(() => handler({ width: boot.width, height: boot.height }));
      } catch {
        /* 同上 */
      }
    }
  },

  onError(handler: (message: string) => void): void {
    if (typeof wxApi!.onError === "function") {
      try {
        // 新基础库的负载可能是 {message, stack} 对象而非字符串，直接 String()
        // 会丢成 "[object Object]"
        wxApi!.onError!((message: unknown) => {
          let text: unknown = message;
          if (text && typeof text === "object") {
            const rec = text as { stack?: unknown; message?: unknown };
            text = rec.stack || rec.message || JSON.stringify(text);
          }
          handler(String(text || "未知错误"));
        });
      } catch {
        /* 同上 */
      }
    }
  },

  storageGet(key: string): string | null {
    try {
      const box = (wxApi!.getStorageSync!("__tve_wx_local_storage__") || {}) as Record<string, unknown>;
      const v = box[key];
      return v == null ? null : String(v);
    } catch {
      return null;
    }
  },

  storageSet(key: string, value: string): void {
    try {
      const box = (wxApi!.getStorageSync!("__tve_wx_local_storage__") || {}) as Record<string, unknown>;
      box[key] = String(value ?? "");
      wxApi!.setStorageSync!("__tve_wx_local_storage__", box);
    } catch {
      /* 存储失败按静默（localStorage 语义本就允许失败） */
    }
  },

  storageRemove(key: string): void {
    try {
      const box = (wxApi!.getStorageSync!("__tve_wx_local_storage__") || {}) as Record<string, unknown>;
      delete box[key];
      wxApi!.setStorageSync!("__tve_wx_local_storage__", box);
    } catch {
      /* 同上 */
    }
  },
};

type TouchHandler = (touch: HostTouch, changedCount: number, activeCount: number) => void;

function bindTouch(name: "onTouchStart" | "onTouchMove" | "onTouchEnd" | "onTouchCancel", handler: TouchHandler): void {
  if (!wxApi || typeof wxApi[name] !== "function") return;
  try {
    wxApi[name]!((res: WxTouchEventLike) => {
      const touches = (res && (res.changedTouches || res.touches)) || [];
      const activeCount = res && Array.isArray(res.touches) ? res.touches.length : touches.length;
      for (const touch of touches) {
        handler(
          {
            identifier: Number(touch.identifier ?? touch.id ?? 0) || 0,
            clientX: Number(touch.clientX) || 0,
            clientY: Number(touch.clientY) || 0,
          },
          touches.length,
          activeCount,
        );
      }
    });
  } catch (e) {
    bridgeLog("warn", `[runtime-bridge] ${name} 桥接失败`, e);
  }
}

type KeyHandler = (key: HostKey) => void;

function bindKey(name: "onKeyDown" | "onKeyUp", handler: KeyHandler): void {
  if (!wxApi || typeof wxApi[name] !== "function") return;
  try {
    wxApi[name]!((res: WxKeyEventLike) => {
      handler({
        key: (res && (res.key || res.text)) || "",
        // 真机差异：无 code 字段时回落 keyCode（可能是数字——保持既有运行时形态）
        code: ((res && (res.code || res.keyCode)) || "") as string,
        keyCode: (res && res.keyCode) || 0,
      });
    });
  } catch (e) {
    bridgeLog("warn", `[runtime-bridge] ${name} 桥接失败`, e);
  }
}

// 求值期注册（渠道入口把本模块排在核心模块之前）
setHost(assertHost(wechatHost));
