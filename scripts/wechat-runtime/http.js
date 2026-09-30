// 适配层 · HTTP：Response/Request/Headers/Blob/AbortController 最小实现 + fetch 垫片。
// 全内联架构下 fetch 只消费两类来源：data: URL 与内联资产表（__TVE_BUILD_DATA.assets）；
// 未命中返回 404 Response（附诊断日志）——不再走 wx 文件系统，懒装载竞态从源头消失。

import { setGlobal, windowRef, isWechatRuntime } from "./env.js";
import { bytesToBase64, base64ToBytes } from "./codec.js";
import { URLShim } from "./url.js";

class TveBlob {
  constructor(parts, options) {
    const chunks = [];
    for (const part of parts || []) {
      if (part instanceof TveBlob) chunks.push(part.__bytes);
      else if (part instanceof Uint8Array) chunks.push(part);
      else if (part instanceof ArrayBuffer) chunks.push(new Uint8Array(part));
      else if (typeof part === "string") chunks.push(new (globalThis.TextEncoder || TextEncoderShimFallback)().encode(part));
    }
    let total = 0;
    for (const c of chunks) total += c.length;
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    this.__bytes = merged;
    this.type = (options && options.type) || "";
    this.size = merged.length;
  }

  arrayBuffer() {
    return Promise.resolve(this.__bytes.slice().buffer);
  }

  text() {
    return Promise.resolve(decodeUtf8(this.__bytes));
  }

  json() {
    return this.text().then((t) => JSON.parse(t));
  }

  slice(start, end, type) {
    const s = Math.max(0, start | 0);
    const e = Math.min(this.__bytes.length, end == null ? this.__bytes.length : end | 0);
    return new TveBlob([this.__bytes.slice(s, Math.max(s, e))], { type: type || this.type });
  }

  stream() {
    throw new Error("TveBlob.stream 不支持（微信小游戏无 ReadableStream）");
  }
}

const TextEncoderShimFallback = globalThis.TextEncoder;

function decodeUtf8(bytes) {
  const dec = globalThis.TextDecoder ? new globalThis.TextDecoder() : null;
  if (dec) return dec.decode(bytes);
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

class TveHeaders {
  constructor(init) {
    this._map = new Map();
    if (init instanceof TveHeaders) {
      for (const [k, v] of init._map) this._map.set(k, v);
    } else if (init && typeof init === "object") {
      for (const [k, v] of Object.entries(init)) this._map.set(String(k).toLowerCase(), String(v));
    }
  }

  append(key, value) {
    const k = String(key).toLowerCase();
    this._map.set(k, [this._map.get(k) || "", String(value)].filter(Boolean).join(", "));
  }

  set(key, value) {
    this._map.set(String(key).toLowerCase(), String(value));
  }

  get(key) {
    const v = this._map.get(String(key).toLowerCase());
    return v == null ? null : v;
  }

  has(key) {
    return this._map.has(String(key).toLowerCase());
  }

  forEach(fn, thisArg) {
    for (const [k, v] of this._map) fn.call(thisArg, v, k, this);
  }

  entries() {
    return this._map.entries();
  }
}

class TveResponse {
  constructor(body, init) {
    const opts = init || {};
    this.status = typeof opts.status === "number" ? opts.status : 200;
    this.statusText = opts.statusText || (this.status === 200 ? "OK" : "");
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = opts.headers instanceof TveHeaders ? opts.headers : new TveHeaders(opts.headers);
    this.type = "basic";
    this.url = opts.url || "";
    this.redirected = false;
    this.bodyUsed = false;
    this.__bytes = body instanceof Uint8Array ? body : new Uint8Array(body instanceof ArrayBuffer ? body : 0);
  }

  arrayBuffer() {
    this.bodyUsed = true;
    return Promise.resolve(this.__bytes.slice().buffer);
  }

  text() {
    this.bodyUsed = true;
    return Promise.resolve(decodeUtf8(this.__bytes));
  }

  json() {
    return this.text().then((t) => JSON.parse(t));
  }

  blob() {
    this.bodyUsed = true;
    return Promise.resolve(new TveBlob([this.__bytes], { type: this.headers.get("content-type") || "" }));
  }

  bytes() {
    this.bodyUsed = true;
    return Promise.resolve(this.__bytes.slice());
  }

  clone() {
    return new TveResponse(this.__bytes.slice(), { status: this.status, statusText: this.statusText, headers: this.headers, url: this.url });
  }
}

class TveRequest {
  constructor(input, init) {
    const opts = init || {};
    this.url = typeof input === "string" ? input : input && input.url ? input.url : String(input);
    this.method = String(opts.method || (input && input.method) || "GET").toUpperCase();
    this.headers = opts.headers instanceof TveHeaders ? opts.headers : new TveHeaders(opts.headers || (input && input.headers));
    this.signal = opts.signal || (input && input.signal) || null;
    this.destination = "";
    this.bodyUsed = false;
    this.mode = "cors";
    this.credentials = "same-origin";
    this.cache = "default";
    this.redirect = "follow";
    this.referrer = "about:client";
  }

  arrayBuffer() {
    return Promise.resolve(new ArrayBuffer(0));
  }

  text() {
    return Promise.resolve("");
  }

  json() {
    return Promise.reject(new Error("TveRequest 无请求体"));
  }

  blob() {
    return Promise.resolve(new TveBlob([]));
  }

  clone() {
    return this;
  }
}

class AbortSignalShim {
  constructor() {
    this.aborted = false;
    this.reason = undefined;
    this.onabort = null;
    this._listeners = new Set();
  }

  addEventListener(type, fn) {
    if (type === "abort" && typeof fn === "function") this._listeners.add(fn);
  }

  removeEventListener(type, fn) {
    this._listeners.delete(fn);
  }

  throwIfAborted() {
    if (this.aborted) throw this.reason || makeAbortError();
  }
}

function makeAbortError() {
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

class AbortControllerShim {
  constructor() {
    this.signal = new AbortSignalShim();
  }

  abort(reason) {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    this.signal.reason = reason || makeAbortError();
    for (const fn of [...this.signal._listeners]) {
      try {
        fn(this.signal.reason);
      } catch {
        /* 监听器异常不扩散 */
      }
    }
    if (typeof this.signal.onabort === "function") {
      try {
        this.signal.onabort(this.signal.reason);
      } catch {
        /* 同上 */
      }
    }
  }
}

/** 内联资产表查找：与 pak 安装垫片同一套键归一化变体（不含小写折叠——数据键
 *  与场景引用同源同大小写，全内联下不经过文件系统）。导出供 Image src 桥接
 *  （three ImageLoader 路径不走 fetch，需独立查表转 data URL）。 */
export function lookupAssetBytes(url) {
  let href = "";
  try {
    href = globalThis.location && globalThis.location.href ? globalThis.location.href : "https://tve.local/game.js";
  } catch {
    href = "https://tve.local/game.js";
  }
  let path = "";
  try {
    const u = new URLShim(url, href);
    if (u.protocol && u.protocol !== "https:" && u.protocol !== "http:") return null;
    path = decodeURIComponent(u.pathname || "");
  } catch {
    path = String(url);
  }
  const data = globalThis.__TVE_BUILD_DATA;
  const assets = data && data.assets;
  if (!assets) return null;
  const keys = [path.replace(/^\/+/, "")];
  const base = href.replace(/[^/]*$/, "");
  const basePath = (() => {
    try {
      return decodeURIComponent(new URLShim(base).pathname || "");
    } catch {
      return base;
    }
  })();
  if (basePath && path.startsWith(basePath)) keys.push(path.slice(basePath.length).replace(/^\/+/, ""));
  if (path.startsWith("./")) keys.push(path.slice(2));
  for (const key of keys) {
    const hit = assets[key];
    if (hit) return base64ToBytes(hit);
  }
  return null;
}

function dataUrlBytes(url) {
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const meta = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  if (/;base64$/i.test(meta)) return base64ToBytes(payload);
  try {
    return new Uint8Array(decodeURIComponent(payload).split("").map((c) => c.charCodeAt(0) & 0xff));
  } catch {
    return null;
  }
}

export async function fetchShim(input, init) {
  const request = input instanceof TveRequest ? input : new TveRequest(input, init);
  if (request.signal && request.signal.aborted) throw makeAbortError();
  if (request.url.startsWith("data:")) {
    const bytes = dataUrlBytes(request.url);
    if (bytes) return new TveResponse(bytes, { status: 200 });
    return new TveResponse(new Uint8Array(0), { status: 400, statusText: "Bad Request" });
  }
  const bytes = lookupAssetBytes(request.url);
  if (bytes) return new TveResponse(bytes, { status: 200, url: request.url });
  console.warn(`[tve-wechat] fetch 未命中内联资产: ${request.url}`);
  return new TveResponse(new Uint8Array(0), { status: 404, statusText: "Not Found", url: request.url });
}

export function installHttpGlobals() {
  if (!isWechatRuntime) return;
  setGlobal("Blob", TveBlob);
  setGlobal("Headers", TveHeaders);
  setGlobal("Response", TveResponse);
  setGlobal("Request", TveRequest);
  setGlobal("AbortController", AbortControllerShim);
  setGlobal("AbortSignal", AbortSignalShim);
  setGlobal("fetch", fetchShim);
  try {
    const w = windowRef.current;
    if (w) w.fetch = fetchShim; // pak 的 installAssetShim 以 window.fetch 为 native 基线
  } catch {
    /* window 未就绪时忽略 */
  }
  return { TveBlob, TveHeaders, TveResponse, TveRequest, fetchShim };
}

// 求值期安装（bootstrap 以 import 装配，见该文件说明）
installHttpGlobals();

export { TveBlob, TveHeaders, TveResponse, TveRequest, AbortControllerShim, AbortSignalShim, makeAbortError };
