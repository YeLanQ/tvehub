// 桥接核心 · 图片。纹理源身份是硬约束：平台 WebGL 的 texImage2D/texSubImage2D 只
// 接受原生平台 image / canvas（包装对象报 "Overload resolution failed"），因此：
// - createImageBitmap：解析字节 → 原生平台 image（补 close），解析出的是纹理源本体；
// - Image 元素（three ImageLoader / createElementNS("img")）：优先同对象增强
//   （src 访问器做内联表桥接——运行期零文件系统，image.src 直读包文件必败），
//   仅平台 src 不可重定义时退化为包装器（桥接仍生效，但该对象不能再作纹理源）。
// imageOrientation 选项忽略：翻转交给 UNPACK_FLIP_Y_WEBGL（纹理 flipY 默认 true）。

import { host, bridgeActive } from "./host.ts";
import { bridgeLog } from "./log.ts";
import { setGlobal } from "./install.ts";
import { Emitter, makeEvent } from "./util.ts";
import { bytesToDataUrl, base64ToBytes } from "./codec.ts";
import { lookupAssetBytes } from "./http.ts";

/** 平台原生 image 鸭子形态（wx.createImage 返回；字段真机不一，逐键容错） */
interface NativeImageLike extends Record<string, unknown> {
  width?: number;
  height?: number;
  close?: () => void;
  onload?: ((res: unknown) => void) | null;
  onerror?: ((err: unknown) => void) | null;
  src?: unknown;
}

function sniffMime(src: string): string {
  if (/\.jpe?g(\?|#|$)/i.test(src)) return "image/jpeg";
  if (/\.png(\?|#|$)/i.test(src)) return "image/png";
  if (/\.webp(\?|#|$)/i.test(src)) return "image/webp";
  if (/\.gif(\?|#|$)/i.test(src)) return "image/gif";
  return "image/png";
}

/** 包内相对路径 → 内联资产表命中即转 data URL（https/data: 原样透传） */
function resolveBridgeSrc(value: unknown): string {
  const raw = String(value ?? "");
  try {
    const bytes = lookupAssetBytes(raw);
    if (bytes) return bytesToDataUrl(bytes, sniffMime(raw));
  } catch {
    /* 查表失败按原路径 */
  }
  return raw;
}

function bytesOf(input: unknown): Uint8Array | null {
  if (!input) return null;
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  const blobLike = input as { __bytes?: unknown };
  if (blobLike.__bytes instanceof Uint8Array) return blobLike.__bytes; // TveBlob
  if (typeof input === "string" && input.startsWith("data:")) {
    const comma = input.indexOf(",");
    const meta = input.slice(5, comma);
    const payload = input.slice(comma + 1);
    return /;base64$/i.test(meta) ? base64ToBytes(payload) : new Uint8Array(0);
  }
  return null;
}

function loadNativeImage(bytes: Uint8Array | null, mimeHint?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!bridgeActive()) {
      reject(new Error("图片能力不可用"));
      return;
    }
    const img = host()!.createImage() as NativeImageLike;
    img.onload = (res: unknown) => {
      const detail = (((res as { detail?: unknown } | null)?.detail as Record<string, unknown>) ||
        (res as Record<string, unknown>) ||
        {}) as { width?: unknown; height?: unknown };
      try {
        if (Number(detail.width) > 0) img.width = Number(detail.width);
        if (Number(detail.height) > 0) img.height = Number(detail.height);
        if (typeof img.close !== "function") img.close = () => {};
      } catch {
        /* 增强失败不影响作为纹理源 */
      }
      resolve(img);
    };
    img.onerror = (err: unknown) => {
      const msg = (err as { errMsg?: unknown } | null)?.errMsg;
      reject(new Error(`图片解码失败: ${msg || "unknown"}`));
    };
    img.src = bytesToDataUrl(bytes || new Uint8Array(0), mimeHint);
  });
}

/** createImageBitmap：输入 bytes/TveBlob → 原生 wx image（合法纹理源）。
 *  输入已是图片对象（原生 image / canvas）时直接透传。 */
export function createImageBitmapShim(input: unknown /* , options */): Promise<unknown> {
  if (
    input &&
    typeof input === "object" &&
    !(input as { __bytes?: unknown }).__bytes &&
    !(input instanceof Uint8Array) &&
    !(input instanceof ArrayBuffer)
  ) {
    // 已是纹理源形态（原生 image/canvas）：直接透传
    return Promise.resolve(input);
  }
  const bytes = bytesOf(input);
  if (!bytes || !bytes.length) return Promise.reject(new Error("createImageBitmap: 不支持的输入形态"));
  return loadNativeImage(bytes, sniffMime(""));
}

/** 同对象增强成功后的元素形态：src 访问器做内联表桥接，事件面经 Emitter */
function enhanceImageInPlace(native: NativeImageLike): boolean {
  const em = new Emitter();
  const desc = Object.getOwnPropertyDescriptor(native, "src");
  const originalSet = desc && typeof desc.set === "function" ? desc.set.bind(native) : null;
  if (!originalSet) return false; // src 非 accessor（平台靠它触发加载）→ 无法桥接
  try {
    Object.defineProperty(native, "addEventListener", {
      configurable: true,
      value: (type: unknown, fn: unknown) => em.on(type as string, fn),
    });
    Object.defineProperty(native, "removeEventListener", {
      configurable: true,
      value: (type: unknown, fn: unknown) => em.off(type as string, fn as (event: unknown) => void),
    });
    let src = "";
    Object.defineProperty(native, "src", {
      configurable: true,
      get: () => src,
      set(value: unknown) {
        src = String(value ?? "");
        const prevLoad = typeof native.onload === "function" ? native.onload : null;
        const prevError = typeof native.onerror === "function" ? native.onerror : null;
        native.onload = (res: unknown) => {
          em.emit("load", makeEvent("load", { target: native }));
          if (prevLoad) prevLoad(res);
        };
        native.onerror = (err: unknown) => {
          const msg = (err as { errMsg?: unknown } | null)?.errMsg;
          bridgeLog("warn", `[runtime-bridge] 图片加载失败: ${src}`, msg || "");
          em.emit("error", makeEvent("error", { target: native }));
          if (prevError) prevError(err);
        };
        originalSet(resolveBridgeSrc(value));
      },
    });
    return true;
  } catch {
    return false;
  }
}

/** 包装器形态（src 不可重定义时的退化元素；桥接生效但不能再作纹理源） */
interface WrappedImageElement extends Record<string, unknown> {
  tagName: string;
  style: Record<string, unknown>;
  complete: boolean;
  width: number;
  height: number;
  __tveNativeImage: unknown;
  addEventListener(type: string, fn: unknown): void;
  removeEventListener(type: string, fn: unknown): void;
}

/** 退化形态：src 不可重定义时的包装器（src 桥接生效，但对象不能再作纹理源） */
function wrapImage(native: NativeImageLike | null): WrappedImageElement {
  const em = new Emitter();
  const el: WrappedImageElement = {
    tagName: "IMG",
    style: {},
    complete: false,
    width: 0,
    height: 0,
    __tveNativeImage: native,
    addEventListener(type: string, fn: unknown) {
      em.on(type, fn);
    },
    removeEventListener(type: string, fn: unknown) {
      em.off(type, fn as (event: unknown) => void);
    },
  };
  if (native) {
    native.onload = (res: unknown) => {
      const detail = (((res as { detail?: unknown } | null)?.detail as Record<string, unknown>) ||
        (res as Record<string, unknown>) ||
        {}) as { width?: unknown; height?: unknown };
      if (Number(detail.width) > 0) el.width = Number(detail.width);
      if (Number(detail.height) > 0) el.height = Number(detail.height);
      el.complete = true;
      em.emit("load", makeEvent("load", { target: el }));
    };
    native.onerror = (err: unknown) => {
      const msg = (err as { errMsg?: unknown } | null)?.errMsg;
      bridgeLog("warn", "[runtime-bridge] 图片加载失败（包装器形态）", msg || "");
      em.emit("error", makeEvent("error", { target: el }));
    };
  }
  let src = "";
  Object.defineProperty(el, "src", {
    configurable: true,
    get: () => src,
    set(value: unknown) {
      src = String(value ?? "");
      if (!native) {
        setTimeout(() => em.emit("error", makeEvent("error", { target: el })), 0);
        return;
      }
      native.src = resolveBridgeSrc(value);
    },
  });
  Object.defineProperty(el, "onload", {
    configurable: true,
    get: () => native && native.onload,
    set(fn: unknown) {
      if (native) native.onload = fn as ((res: unknown) => void) | null;
    },
  });
  Object.defineProperty(el, "onerror", {
    configurable: true,
    get: () => native && native.onerror,
    set(fn: unknown) {
      if (native) native.onerror = fn as ((err: unknown) => void) | null;
    },
  });
  return el;
}

/** Image 元素：优先同对象增强（纹理源身份 + src 桥接双保证），失败退化包装器 */
export function createImageElement(): unknown {
  const native = bridgeActive() ? (host()!.createImage() as NativeImageLike) : null;
  if (!native) return wrapImage(null);
  if (enhanceImageInPlace(native)) return native;
  bridgeLog("warn", "[runtime-bridge] image src 不可重定义，退化为包装器（该图片不能再作纹理源）");
  return wrapImage(native);
}

function ImageClass(width?: unknown, height?: unknown): unknown {
  const el = createImageElement() as WrappedImageElement;
  try {
    if (Number(width) > 0) el.width = Number(width);
    if (Number(height) > 0) el.height = Number(height);
  } catch {
    /* 尺寸预设失败忽略 */
  }
  return el;
}

/** Image 垫片安装结果（安装过才有返回值） */
export interface ImageShims {
  ImageClass: typeof ImageClass;
  createImageBitmapShim: typeof createImageBitmapShim;
}

export function installImageGlobals(): ImageShims | undefined {
  if (!bridgeActive()) return undefined;
  setGlobal("Image", ImageClass);
  setGlobal("createImageBitmap", createImageBitmapShim);
  return { ImageClass, createImageBitmapShim };
}

// 求值期安装（渠道入口以 import 装配，见 entries 说明）
installImageGlobals();
