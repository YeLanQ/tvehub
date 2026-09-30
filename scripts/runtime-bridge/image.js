// 桥接核心 · 图片。纹理源身份是硬约束：平台 WebGL 的 texImage2D/texSubImage2D 只
// 接受原生平台 image / canvas（包装对象报 "Overload resolution failed"），因此：
// - createImageBitmap：解析字节 → 原生平台 image（补 close），解析出的是纹理源本体；
// - Image 元素（three ImageLoader / createElementNS("img")）：优先同对象增强
//   （src 访问器做内联表桥接——运行期零文件系统，image.src 直读包文件必败），
//   仅平台 src 不可重定义时退化为包装器（桥接仍生效，但该对象不能再作纹理源）。
// imageOrientation 选项忽略：翻转交给 UNPACK_FLIP_Y_WEBGL（纹理 flipY 默认 true）。

import { host, bridgeActive } from "./host.js";
import { setGlobal } from "./install.js";
import { Emitter, makeEvent } from "./util.js";
import { bytesToDataUrl, base64ToBytes } from "./codec.js";
import { lookupAssetBytes } from "./http.js";

function sniffMime(src) {
  if (/\.jpe?g(\?|#|$)/i.test(src)) return "image/jpeg";
  if (/\.png(\?|#|$)/i.test(src)) return "image/png";
  if (/\.webp(\?|#|$)/i.test(src)) return "image/webp";
  if (/\.gif(\?|#|$)/i.test(src)) return "image/gif";
  return "image/png";
}

/** 包内相对路径 → 内联资产表命中即转 data URL（https/data: 原样透传） */
function resolveBridgeSrc(value) {
  const raw = String(value ?? "");
  try {
    const bytes = lookupAssetBytes(raw);
    if (bytes) return bytesToDataUrl(bytes, sniffMime(raw));
  } catch {
    /* 查表失败按原路径 */
  }
  return raw;
}

function bytesOf(input) {
  if (!input) return null;
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (input.__bytes instanceof Uint8Array) return input.__bytes; // TveBlob
  if (typeof input === "string" && input.startsWith("data:")) {
    const comma = input.indexOf(",");
    const meta = input.slice(5, comma);
    const payload = input.slice(comma + 1);
    return /;base64$/i.test(meta) ? base64ToBytes(payload) : new Uint8Array(0);
  }
  return null;
}

function loadNativeImage(bytes, mimeHint) {
  return new Promise((resolve, reject) => {
    if (!bridgeActive()) {
      reject(new Error("图片能力不可用"));
      return;
    }
    const img = host().createImage();
    img.onload = (res) => {
      const detail = (res && res.detail) || res || {};
      try {
        if (Number(detail.width) > 0) img.width = Number(detail.width);
        if (Number(detail.height) > 0) img.height = Number(detail.height);
        if (typeof img.close !== "function") img.close = () => {};
      } catch {
        /* 增强失败不影响作为纹理源 */
      }
      resolve(img);
    };
    img.onerror = (err) => {
      reject(new Error(`图片解码失败: ${(err && err.errMsg) || "unknown"}`));
    };
    img.src = bytesToDataUrl(bytes || new Uint8Array(0), mimeHint);
  });
}

/** createImageBitmap：输入 bytes/TveBlob → 原生 wx image（合法纹理源）。
 *  输入已是图片对象（原生 image / canvas）时直接透传。 */
export function createImageBitmapShim(input /* , options */) {
  if (input && typeof input === "object" && !input.__bytes && !(input instanceof Uint8Array) && !(input instanceof ArrayBuffer)) {
    // 已是纹理源形态（原生 image/canvas）：直接透传
    return Promise.resolve(input);
  }
  const bytes = bytesOf(input);
  if (!bytes || !bytes.length) return Promise.reject(new Error("createImageBitmap: 不支持的输入形态"));
  return loadNativeImage(bytes, sniffMime(""));
}

/** 同对象增强成功后的元素形态：src 访问器做内联表桥接，事件面经 Emitter */
function enhanceImageInPlace(native) {
  const em = new Emitter();
  const desc = Object.getOwnPropertyDescriptor(native, "src");
  const originalSet = desc && typeof desc.set === "function" ? desc.set.bind(native) : null;
  if (!originalSet) return false; // src 非 accessor（平台靠它触发加载）→ 无法桥接
  try {
    Object.defineProperty(native, "addEventListener", {
      configurable: true,
      value: (type, fn) => em.on(type, fn),
    });
    Object.defineProperty(native, "removeEventListener", {
      configurable: true,
      value: (type, fn) => em.off(type, fn),
    });
    let src = "";
    Object.defineProperty(native, "src", {
      configurable: true,
      get: () => src,
      set(value) {
        src = String(value ?? "");
        const prevLoad = typeof native.onload === "function" ? native.onload : null;
        const prevError = typeof native.onerror === "function" ? native.onerror : null;
        native.onload = (res) => {
          em.emit("load", makeEvent("load", { target: native }));
          if (prevLoad) prevLoad(res);
        };
        native.onerror = (err) => {
          console.warn(`[runtime-bridge] 图片加载失败: ${src}`, (err && err.errMsg) || "");
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

/** 退化形态：src 不可重定义时的包装器（src 桥接生效，但对象不能再作纹理源） */
function wrapImage(native) {
  const em = new Emitter();
  const el = {
    tagName: "IMG",
    style: {},
    complete: false,
    width: 0,
    height: 0,
    __tveNativeImage: native,
    addEventListener(type, fn) {
      em.on(type, fn);
    },
    removeEventListener(type, fn) {
      em.off(type, fn);
    },
  };
  if (native) {
    native.onload = (res) => {
      const detail = (res && res.detail) || res || {};
      if (Number(detail.width) > 0) el.width = Number(detail.width);
      if (Number(detail.height) > 0) el.height = Number(detail.height);
      el.complete = true;
      em.emit("load", makeEvent("load", { target: el }));
    };
    native.onerror = (err) => {
      console.warn("[runtime-bridge] 图片加载失败（包装器形态）", (err && err.errMsg) || "");
      em.emit("error", makeEvent("error", { target: el }));
    };
  }
  let src = "";
  Object.defineProperty(el, "src", {
    configurable: true,
    get: () => src,
    set(value) {
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
    set(fn) {
      if (native) native.onload = fn;
    },
  });
  Object.defineProperty(el, "onerror", {
    configurable: true,
    get: () => native && native.onerror,
    set(fn) {
      if (native) native.onerror = fn;
    },
  });
  return el;
}

/** Image 元素：优先同对象增强（纹理源身份 + src 桥接双保证），失败退化包装器 */
export function createImageElement() {
  const native = bridgeActive() ? host().createImage() : null;
  if (!native) return wrapImage(null);
  if (enhanceImageInPlace(native)) return native;
  console.warn("[runtime-bridge] image src 不可重定义，退化为包装器（该图片不能再作纹理源）");
  return wrapImage(native);
}

function ImageClass(width, height) {
  const el = createImageElement();
  try {
    if (Number(width) > 0) el.width = Number(width);
    if (Number(height) > 0) el.height = Number(height);
  } catch {
    /* 尺寸预设失败忽略 */
  }
  return el;
}

export function installImageGlobals() {
  if (!bridgeActive()) return;
  setGlobal("Image", ImageClass);
  setGlobal("createImageBitmap", createImageBitmapShim);
  return { ImageClass, createImageBitmapShim };
}

// 求值期安装（渠道入口以 import 装配，见 entries 说明）
installImageGlobals();
