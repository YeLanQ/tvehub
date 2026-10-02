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
import { assertHost } from "../contract.ts";

const wxApi = (() => {
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
const wxWasm = (() => {
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
function wasmFileHash(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let h = 0x811c9dc5;
  for (let i = 0; i < view.length; i++) {
    h ^= view[i];
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 字节归一为 ArrayBuffer（TypedArray 可能带 byteOffset，复制出独立缓冲） */
function toArrayBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes;
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer ?? bytes);
  return view.slice().buffer;
}

/**
 * 实例化 wasm：字节落盘用户目录 → WXWebAssembly.instantiate(path)。
 * 路径形态全基础库可用；目录缺失/写盘失败时回落直传字节（新基础库兼容），
 * 全链失败抛出（物理世界创建入口会把报错落到日志，游戏继续无物理运行）。
 */
async function instantiateWasmViaFile(bytes, imports) {
  const buffer = toArrayBuffer(bytes);
  const dir = wxApi && wxApi.env && wxApi.env.USER_DATA_PATH;
  const fsm = wxApi && typeof wxApi.getFileSystemManager === "function" ? wxApi.getFileSystemManager() : null;
  if (dir && fsm && typeof fsm.writeFileSync === "function") {
    const path = `${dir}/tve-wasm-${wasmFileHash(new Uint8Array(buffer))}.wasm`;
    try {
      fsm.writeFileSync(path, buffer, "binary");
      return await wxWasm.instantiate(path, imports);
    } catch (e) {
      bridgeLog("warn", "[runtime-bridge] wasm 文件形态实例化失败，回落直传字节", e);
    }
  }
  return await wxWasm.instantiate(buffer, imports);
}

function readViewport() {
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

const wechatHost = {
  platformId: "wechat",

  available() {
    return !!wxApi;
  },

  // wasm 实例化能力（桥接核心 WebAssembly 垫片的落地机制）：
  // - 包内路径形态（构建期改写的引擎胶水）：WXWebAssembly.instantiate(path) 直连
  //   ——基础库只认代码包内 .wasm/.wasm.br 文件路径（wxfile: 用户目录与字节直传
  //   均被拒，2026-10 工具实报）；WXWebAssembly 缺席时原生 WebAssembly 兜底
  //   （读包内文件为字节）。
  // - 字节形态（垫片兜底链）：落盘用户目录 → 直传字节。
  instantiateWasm(source, imports) {
    if (typeof source === "string") {
      if (wxWasm && typeof wxWasm.instantiate === "function") {
        return wxWasm.instantiate(source, imports);
      }
      try {
        if (typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function") {
          const fsm = wxApi && typeof wxApi.getFileSystemManager === "function" ? wxApi.getFileSystemManager() : null;
          if (fsm && typeof fsm.readFileSync === "function") {
            const bytes = fsm.readFileSync(source);
            return WebAssembly.instantiate(bytes, imports);
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
        return WebAssembly.instantiate(toArrayBuffer(source), imports);
      }
    } catch {
      /* 沙箱遮蔽时读 free 标识符可能抛错 */
    }
    return null;
  },

  getViewport: readViewport,

  requestAnimationFrame(fn) {
    if (wxApi && typeof wxApi.requestAnimationFrame === "function") {
      return wxApi.requestAnimationFrame(fn);
    }
    // rAF 缺失环境回退 16ms setTimeout
    return setTimeout(() => fn(Date.now()), 16);
  },

  cancelAnimationFrame(id) {
    if (wxApi && typeof wxApi.cancelAnimationFrame === "function") {
      return wxApi.cancelAnimationFrame(id);
    }
    return clearTimeout(id);
  },

  // 首调 wx.createCanvas() 即屏上画布（整个包内仅核心 canvas 模块调用一次）
  createScreenCanvas() {
    return wxApi.createCanvas();
  },

  // 离屏画布兜底链（全部 wx 侧形态）：createOffscreenCanvas({type:"2d"}) →
  // createOffscreenCanvas() → 二次 wx.createCanvas()（首画布已被屏上占用，
  // 二次得离屏）。全链失败返回 null，由核心决定末级兜底。
  createOffscreenCanvas(width, height) {
    let canvas = null;
    try {
      if (typeof wxApi.createOffscreenCanvas === "function") {
        canvas = wxApi.createOffscreenCanvas({ type: "2d", width, height });
      }
    } catch {
      canvas = null;
    }
    if (!canvas) {
      try {
        if (typeof wxApi.createOffscreenCanvas === "function") {
          canvas = wxApi.createOffscreenCanvas();
        }
      } catch {
        canvas = null;
      }
    }
    if (!canvas) {
      try {
        canvas = wxApi.createCanvas();
      } catch {
        canvas = null;
      }
    }
    return canvas;
  },

  createImage() {
    return wxApi.createImage();
  },

  createAudioContext() {
    try {
      if (typeof wxApi.createWebAudioContext === "function") return wxApi.createWebAudioContext();
    } catch (e) {
      bridgeLog("warn", "[runtime-bridge] WebAudio 创建失败（音频将静音）", e);
    }
    return null;
  },

  // 读代码包内文件为字节（资产文件化清单的落地机制）：readFileSync 无 encoding
  // 返回 ArrayBuffer，支持代码包相对路径；失败/不支持返回 null（调用方走缺失降级）。
  // byteLength duck-type 判定：instanceof 跨 realm（vm/多上下文）不可靠。
  readPackageFile(rel) {
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

  onTouchStart(handler) {
    bindTouch("onTouchStart", handler);
  },
  onTouchMove(handler) {
    bindTouch("onTouchMove", handler);
  },
  onTouchEnd(handler) {
    bindTouch("onTouchEnd", handler);
  },
  onTouchCancel(handler) {
    bindTouch("onTouchCancel", handler);
  },

  onKeyDown(handler) {
    bindKey("onKeyDown", handler);
  },
  onKeyUp(handler) {
    bindKey("onKeyUp", handler);
  },

  onShow(handler) {
    if (typeof wxApi.onShow === "function") {
      try {
        wxApi.onShow(() => handler());
      } catch {
        /* 生命周期注册失败忽略 */
      }
    }
  },

  onHide(handler) {
    if (typeof wxApi.onHide === "function") {
      try {
        wxApi.onHide(() => handler());
      } catch {
        /* 同上 */
      }
    }
  },

  onWindowResize(handler) {
    if (typeof wxApi.onWindowResize === "function") {
      try {
        wxApi.onWindowResize((res) => handler({ width: res && res.windowWidth, height: res && res.windowHeight }));
      } catch {
        /* 同上 */
      }
    }
  },

  onError(handler) {
    if (typeof wxApi.onError === "function") {
      try {
        wxApi.onError((message) => handler(String(message || "未知错误")));
      } catch {
        /* 同上 */
      }
    }
  },

  storageGet(key) {
    try {
      const box = wxApi.getStorageSync("__tve_wx_local_storage__") || {};
      const v = box[key];
      return v == null ? null : String(v);
    } catch {
      return null;
    }
  },

  storageSet(key, value) {
    try {
      const box = wxApi.getStorageSync("__tve_wx_local_storage__") || {};
      box[key] = String(value ?? "");
      wxApi.setStorageSync("__tve_wx_local_storage__", box);
    } catch {
      /* 存储失败按静默（localStorage 语义本就允许失败） */
    }
  },

  storageRemove(key) {
    try {
      const box = wxApi.getStorageSync("__tve_wx_local_storage__") || {};
      delete box[key];
      wxApi.setStorageSync("__tve_wx_local_storage__", box);
    } catch {
      /* 同上 */
    }
  },
};

function bindTouch(name, handler) {
  if (!wxApi || typeof wxApi[name] !== "function") return;
  try {
    wxApi[name]((res) => {
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

function bindKey(name, handler) {
  if (!wxApi || typeof wxApi[name] !== "function") return;
  try {
    wxApi[name]((res) => {
      handler({
        key: (res && (res.key || res.text)) || "",
        code: (res && (res.code || res.keyCode)) || "",
        keyCode: (res && res.keyCode) || 0,
      });
    });
  } catch (e) {
    bridgeLog("warn", `[runtime-bridge] ${name} 桥接失败`, e);
  }
}

// 求值期注册（渠道入口把本模块排在核心模块之前）
setHost(assertHost(wechatHost));
