// 桥接核心 · 编解码：base64（atob/btoa，wx 环境无原生实现）与 TextEncoder/TextDecoder
// 缺失兜底。GLTF 内嵌 data URI、fetch data: URL、createImageBitmap 均消费。

import { bridgeActive } from "./host.ts";
import { setGlobal } from "./install.ts";

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? 0);
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

export function base64ToBytes(text) {
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

export function bytesToDataUrl(bytes, mime) {
  return `data:${mime || "application/octet-stream"};base64,${bytesToBase64(bytes)}`;
}

class TextEncoderShim {
  get encoding() {
    return "utf-8";
  }
  encode(text) {
    const s = String(text ?? "");
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let cp = s.codePointAt(i);
      if (cp > 0xffff) i++;
      if (cp < 0x80) out.push(cp);
      else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
      else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
    return new Uint8Array(out);
  }
}

class TextDecoderShim {
  get encoding() {
    return "utf-8";
  }
  decode(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? 0);
    let out = "";
    let i = 0;
    while (i < u8.length) {
      const b = u8[i];
      let cp;
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
      out += String.fromCodePoint(cp);
    }
    return out;
  }
}

export function installCodecGlobals() {
  if (!bridgeActive()) return;
  if (typeof globalThis.btoa !== "function") setGlobal("btoa", (s) => bytesToBase64(new TextEncoderShim().encode(String(s))));
  if (typeof globalThis.atob !== "function") setGlobal("atob", (s) => new TextDecoderShim().decode(base64ToBytes(String(s))));
  if (typeof globalThis.TextEncoder !== "function") setGlobal("TextEncoder", TextEncoderShim);
  if (typeof globalThis.TextDecoder !== "function") setGlobal("TextDecoder", TextDecoderShim);
  return { TextEncoderShim, TextDecoderShim };
}

// 求值期安装（bootstrap 以 import 装配，见该文件说明）
installCodecGlobals();
