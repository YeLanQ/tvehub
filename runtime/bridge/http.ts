// 桥接核心 · HTTP：Response/Request/Headers/Blob/AbortController 最小实现 + fetch 垫片。
// fetch 消费三类来源：data: URL、内联资产表（场景/小文本）与文件化资产清单
// （二进制落盘包内文件，经端点 readPackageFile 读取）；未命中返回 404 Response
// （附诊断日志）——文件读取限定在「构建期清单 + 代码包」内，无懒装载竞态面。

import { bridgeActive, host } from "./host.ts";
import { bridgeLog } from "./log.ts";
import { setGlobal, windowRef } from "./install.ts";
import { base64ToBytes } from "./codec.ts";
import { URLShim } from "./url.ts";

/** Blob/Response 构造的 parts 成员鸭子形态 */
type BlobPart = TveBlob | Uint8Array | ArrayBuffer | string;

export class TveBlob {
  __bytes: Uint8Array;
  type: string;
  size: number;

  constructor(parts: Iterable<BlobPart> | null | undefined, options?: { type?: string } | null) {
    const chunks: Uint8Array[] = [];
    for (const part of parts || []) {
      if (part instanceof TveBlob) chunks.push(part.__bytes);
      else if (part instanceof Uint8Array) chunks.push(part);
      else if (part instanceof ArrayBuffer) chunks.push(new Uint8Array(part));
      else if (typeof part === "string")
        chunks.push(new (globalThis.TextEncoder || TextEncoderShimFallback)().encode(part));
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

  arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(this.__bytes.slice().buffer);
  }

  text(): Promise<string> {
    return Promise.resolve(decodeUtf8(this.__bytes));
  }

  json(): Promise<unknown> {
    return this.text().then((t) => JSON.parse(t) as unknown);
  }

  slice(start?: number, end?: number, type?: string): TveBlob {
    const s = Math.max(0, (start ?? 0) | 0);
    const e = Math.min(this.__bytes.length, end == null ? this.__bytes.length : end | 0);
    return new TveBlob([this.__bytes.slice(s, Math.max(s, e))], { type: type || this.type });
  }

  stream(): never {
    throw new Error("TveBlob.stream 不支持（微信小游戏无 ReadableStream）");
  }
}

const TextEncoderShimFallback = globalThis.TextEncoder;

function decodeUtf8(bytes: Uint8Array): string {
  const dec = globalThis.TextDecoder ? new globalThis.TextDecoder() : null;
  if (dec) return dec.decode(bytes);
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

export class TveHeaders {
  private _map: Map<string, string>;

  constructor(init?: TveHeaders | Record<string, unknown> | null | undefined) {
    this._map = new Map();
    if (init instanceof TveHeaders) {
      for (const [k, v] of init._map) this._map.set(k, v);
    } else if (init && typeof init === "object") {
      for (const [k, v] of Object.entries(init)) this._map.set(String(k).toLowerCase(), String(v));
    }
  }

  append(key: string, value: unknown): void {
    const k = String(key).toLowerCase();
    this._map.set(k, [this._map.get(k) || "", String(value)].filter(Boolean).join(", "));
  }

  set(key: string, value: unknown): void {
    this._map.set(String(key).toLowerCase(), String(value));
  }

  get(key: string): string | null {
    const v = this._map.get(String(key).toLowerCase());
    return v == null ? null : v;
  }

  has(key: string): boolean {
    return this._map.has(String(key).toLowerCase());
  }

  forEach(fn: (value: string, key: string) => void, thisArg?: unknown): void {
    for (const [k, v] of this._map) fn.call(thisArg, v, k);
  }

  entries(): IterableIterator<[string, string]> {
    return this._map.entries();
  }
}

/** fetch 垫片的 Response 形态（引擎/pak 消费的标准子集） */
export class TveResponse {
  status: number;
  statusText: string;
  ok: boolean;
  headers: TveHeaders;
  type: string;
  url: string;
  redirected: boolean;
  bodyUsed: boolean;
  __bytes: Uint8Array;

  constructor(body: unknown, init?: TveResponseInit | null) {
    const opts: TveResponseInit = init || {};
    this.status = typeof opts.status === "number" ? opts.status : 200;
    this.statusText = opts.statusText || (this.status === 200 ? "OK" : "");
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = opts.headers instanceof TveHeaders ? opts.headers : new TveHeaders(opts.headers);
    this.type = "basic";
    this.url = opts.url || "";
    this.redirected = false;
    this.bodyUsed = false;
    this.__bytes = body instanceof Uint8Array ? body : new Uint8Array((body instanceof ArrayBuffer ? body : 0) as ArrayBuffer);
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    this.bodyUsed = true;
    return Promise.resolve(this.__bytes.slice().buffer);
  }

  text(): Promise<string> {
    this.bodyUsed = true;
    return Promise.resolve(decodeUtf8(this.__bytes));
  }

  json(): Promise<unknown> {
    return this.text().then((t) => JSON.parse(t) as unknown);
  }

  blob(): Promise<TveBlob> {
    this.bodyUsed = true;
    return Promise.resolve(new TveBlob([this.__bytes], { type: this.headers.get("content-type") || "" }));
  }

  bytes(): Promise<Uint8Array> {
    this.bodyUsed = true;
    return Promise.resolve(this.__bytes.slice());
  }

  clone(): TveResponse {
    return new TveResponse(this.__bytes.slice(), {
      status: this.status,
      statusText: this.statusText,
      headers: this.headers,
      url: this.url,
    });
  }
}

/** fetch 垫片 init 的鸭子形态（Response/Request 构造共用字段） */
interface TveResponseInit {
  status?: number;
  statusText?: string;
  headers?: TveHeaders | Record<string, unknown>;
  url?: string;
}

export class TveRequest {
  url: string;
  method: string;
  headers: TveHeaders;
  signal: AbortSignalShim | null;
  destination: string;
  bodyUsed: boolean;
  mode: string;
  credentials: string;
  cache: string;
  redirect: string;
  referrer: string;

  constructor(input: unknown, init?: TveRequestInit | null) {
    const opts: TveRequestInit = init || {};
    const base = input as { url?: unknown; method?: unknown; headers?: unknown; signal?: unknown } | null;
    this.url =
      typeof input === "string" ? input : base && base.url ? String(base.url) : String(input);
    this.method = String(opts.method || (base && base.method) || "GET").toUpperCase();
    this.headers =
      opts.headers instanceof TveHeaders
        ? opts.headers
        : new TveHeaders((opts.headers || (base && base.headers)) as Record<string, unknown> | undefined);
    this.signal = (opts.signal || (base && base.signal) || null) as AbortSignalShim | null;
    this.destination = "";
    this.bodyUsed = false;
    this.mode = "cors";
    this.credentials = "same-origin";
    this.cache = "default";
    this.redirect = "follow";
    this.referrer = "about:client";
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(new ArrayBuffer(0));
  }

  text(): Promise<string> {
    return Promise.resolve("");
  }

  json(): Promise<unknown> {
    return Promise.reject(new Error("TveRequest 无请求体"));
  }

  blob(): Promise<TveBlob> {
    return Promise.resolve(new TveBlob([]));
  }

  clone(): TveRequest {
    return this;
  }
}

/** fetch 垫片 init 的鸭子形态 */
interface TveRequestInit {
  method?: string;
  headers?: TveHeaders | Record<string, unknown>;
  signal?: AbortSignalShim | null;
}

export class AbortSignalShim {
  aborted: boolean;
  reason: unknown;
  onabort: ((reason: unknown) => void) | null;
  _listeners: Set<(reason: unknown) => void>; // AbortControllerShim 触发用（同类族内部约定）

  constructor() {
    this.aborted = false;
    this.reason = undefined;
    this.onabort = null;
    this._listeners = new Set();
  }

  addEventListener(type: string, fn: unknown): void {
    if (type === "abort" && typeof fn === "function") {
      this._listeners.add(fn as (reason: unknown) => void);
    }
  }

  removeEventListener(type: string, fn: unknown): void {
    if (type === "abort") this._listeners.delete(fn as (reason: unknown) => void);
  }

  throwIfAborted(): void {
    if (this.aborted) throw this.reason || makeAbortError();
  }
}

function makeAbortError(): Error {
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

export class AbortControllerShim {
  signal: AbortSignalShim;

  constructor() {
    this.signal = new AbortSignalShim();
  }

  abort(reason?: unknown): void {
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

/** 内联构建数据鸭子形态（data-bridge 装配；资产表 + 文件化清单） */
interface BuildDataLike {
  config?: Record<string, unknown>;
  assets?: Record<string, string>;
  assetFiles?: Record<string, string>;
}

/** 内联资产表查找：与 pak 安装垫片同一套键归一化变体（不含小写折叠——数据键
 *  与场景引用同源同大小写）。资产文件化后二进制不在表内：内联 miss 落到
 *  assetFiles 清单（rel → 包内文件路径）→ 端点 readPackageFile 同步读字节。
 *  导出供 Image src 桥接（three ImageLoader 路径不走 fetch，需独立查表）。 */
export function lookupAssetBytes(url: string): Uint8Array | null {
  let href = "";
  try {
    href =
      globalThis.location && globalThis.location.href ? globalThis.location.href : "https://tve.local/game.js";
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
  const data = (globalThis as unknown as { __TVE_BUILD_DATA?: BuildDataLike }).__TVE_BUILD_DATA;
  const assets = data && data.assets;
  if (!assets && !(data && data.assetFiles)) return null;
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
  // ① 内联表（场景/小文本资产）
  for (const key of keys) {
    const hit = assets && assets[key];
    if (hit) return base64ToBytes(hit);
  }
  // ② 文件化资产清单：rel → 包内路径 → 端点同步读字节（同步读保证本函数
  //    的同步契约不破；端点 null = 不支持/缺失，走调用方降级）
  const assetFiles = data && data.assetFiles;
  if (assetFiles) {
    const endpoint = host();
    for (const key of keys) {
      const file = assetFiles[key];
      if (!file) continue;
      const bytes = endpoint && typeof endpoint.readPackageFile === "function" ? endpoint.readPackageFile(file) : null;
      if (bytes) return new Uint8Array(bytes);
    }
  }
  return null;
}

function dataUrlBytes(url: string): Uint8Array | null {
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

export async function fetchShim(input: unknown, init?: TveRequestInit | null): Promise<TveResponse> {
  const request = input instanceof TveRequest ? input : new TveRequest(input, init);
  if (request.signal && request.signal.aborted) throw makeAbortError();
  if (request.url.startsWith("data:")) {
    const bytes = dataUrlBytes(request.url);
    if (bytes) return new TveResponse(bytes, { status: 200 });
    return new TveResponse(new Uint8Array(0), { status: 400, statusText: "Bad Request" });
  }
  const bytes = lookupAssetBytes(request.url);
  if (bytes) return new TveResponse(bytes, { status: 200, url: request.url });
  bridgeLog("warn", `[runtime-bridge] fetch 未命中内联资产: ${request.url}`);
  return new TveResponse(new Uint8Array(0), { status: 404, statusText: "Not Found", url: request.url });
}

/** HTTP 垫片安装结果（安装过才有返回值） */
export interface HttpShims {
  TveBlob: typeof TveBlob;
  TveHeaders: typeof TveHeaders;
  TveResponse: typeof TveResponse;
  TveRequest: typeof TveRequest;
  fetchShim: typeof fetchShim;
}

export function installHttpGlobals(): HttpShims | undefined {
  if (!bridgeActive()) return undefined;
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

export { makeAbortError };
