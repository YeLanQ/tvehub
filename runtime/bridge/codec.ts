// 桥接核心 · 编解码：base64（atob/btoa，wx 环境无原生实现）与 TextEncoder/TextDecoder
// 缺失兜底。GLTF 内嵌 data URI、fetch data: URL、createImageBitmap 均消费。

import { bridgeActive } from "./host.ts";
import { setGlobal } from "./install.ts";

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** 可解码字节形态（TypedArray/ArrayBuffer 均收，duck 判定见各消费点） */
export type BytesLike = ArrayBuffer | Uint8Array;

export function bytesToBase64(bytes: BytesLike | null | undefined): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array((bytes ?? 0) as ArrayBuffer);
  let out = "";
  const len = u8.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = u8[i];
    const b1 = i + 1 < len ? u8[i + 1] : 0;
    const b2 = i + 2 < len ? u8[i + 2] : 0;
    out += B64_CHARS[b0 >> 2];
    out += B64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < len ? B64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < len ? B64_CHARS[b2 & 63] : "=";
  }
  return out;
}

const B64_LOOKUP = (() => {
  const table = new Uint8Array(128);
  for (let i = 0; i < B64_CHARS.length; i++) table[B64_CHARS.charCodeAt(i)] = i;
  return table;
})();

export function base64ToBytes(text: unknown): Uint8Array {
  const clean = String(text ?? "").replace(/[^A-Za-z0-9+/=]/g, "");
  const len = clean.length;
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const out = new Uint8Array(Math.max(0, Math.floor((len / 4) * 3) - pad));
  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const c0 = B64_LOOKUP[clean.charCodeAt(i)] || 0;
    const c1 = B64_LOOKUP[clean.charCodeAt(i + 1)] || 0;
    const c2 = B64_LOOKUP[clean.charCodeAt(i + 2)] || 0;
    const c3 = B64_LOOKUP[clean.charCodeAt(i + 3)] || 0;
    if (p < out.length) out[p++] = (c0 << 2) | (c1 >> 4);
    if (p < out.length) out[p++] = ((c1 & 15) << 4) | (c2 >> 2);
    if (p < out.length) out[p++] = ((c2 & 3) << 6) | c3;
  }
  return out;
}

export function bytesToDataUrl(bytes: BytesLike, mime?: string): string {
  return `data:${mime || "application/octet-stream"};base64,${bytesToBase64(bytes)}`;
}

/** TextEncoder 缺失兜底（仅 utf-8；与原生同名方法同形） */
class TextEncoderShim {
  get encoding(): string {
    return "utf-8";
  }

  encode(text: unknown): Uint8Array {
    const s = String(text ?? "");
    const out: number[] = [];
    for (let i = 0; i < s.length; i++) {
      let cp = s.codePointAt(i) ?? 0;
      if (cp > 0xffff) i++;
      if (cp < 0x80) out.push(cp);
      else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
      else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
    return new Uint8Array(out);
  }
}

/** TextDecoder 缺失兜底（仅 utf-8；非 fatal 语义） */
class TextDecoderShim {
  get encoding(): string {
    return "utf-8";
  }

  decode(bytes: BytesLike | null | undefined): string {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array((bytes ?? 0) as ArrayBuffer);
    let out = "";
    let i = 0;
    while (i < u8.length) {
      const b = u8[i];
      let cp: number;
      if (b < 0x80) {
        cp = b;
        i += 1;
      } else if (b < 0xe0) {
        cp = ((b & 31) << 6) | (u8[i + 1] & 63);
        i += 2;
      } else if (b < 0xf0) {
        cp = ((b & 15) << 12) | ((u8[i + 1] & 63) << 6) | (u8[i + 2] & 63);
        i += 3;
      } else {
        cp = ((b & 7) << 18) | ((u8[i + 1] & 63) << 12) | ((u8[i + 2] & 63) << 6) | (u8[i + 3] & 63);
        i += 4;
      }
      // 非 fatal 语义：越界码点与代理区一律替换 U+FFFD（二进制误入时不得抛
      // RangeError——真机曾因 PNG 字节被当 UTF-8 解出 0x1A2CA2 直接炸启动链）
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
      out += String.fromCodePoint(cp);
    }
    return out;
  }
}

/** 字节 → 二进制字符串（一字节一字符，atob 标准语义；块级 apply 防栈溢出） */
function bytesToBinaryString(u8: Uint8Array): string {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    out += String.fromCharCode.apply(null, u8.subarray(i, i + chunk) as unknown as number[]);
  }
  return out;
}

/** 编解码垫片安装结果（安装过才有返回值） */
export interface CodecShims {
  TextEncoderShim: typeof TextEncoderShim;
  TextDecoderShim: typeof TextDecoderShim;
}

export function installCodecGlobals(): CodecShims | undefined {
  if (!bridgeActive()) return undefined;
  if (typeof (globalThis as unknown as Record<string, unknown>).btoa !== "function")
    setGlobal("btoa", (s: unknown) => bytesToBase64(new TextEncoderShim().encode(String(s))));
  // atob 标准语义 = 二进制字符串（非 UTF-8 解码）：消费方（GLTF data URI、
  // fetch data:）按字符取字节后再自行 TextDecoder，此前误接 UTF-8 解码器，
  // 二进制载荷在真机必炸（模拟器有原生 atob 不走垫片，从不复现）
  if (typeof (globalThis as unknown as Record<string, unknown>).atob !== "function")
    setGlobal("atob", (s: unknown) => bytesToBinaryString(base64ToBytes(String(s))));
  if (typeof (globalThis as unknown as Record<string, unknown>).TextEncoder !== "function")
    setGlobal("TextEncoder", TextEncoderShim);
  if (typeof (globalThis as unknown as Record<string, unknown>).TextDecoder !== "function")
    setGlobal("TextDecoder", TextDecoderShim);
  return { TextEncoderShim, TextDecoderShim };
}

// 求值期安装（bootstrap 以 import 装配，见该文件说明）
installCodecGlobals();
