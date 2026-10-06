// 桥接层 · base64 编解码（环境无关）：真机 worker 线程无 atob/btoa（WebAudio/
// DOM 垫片都不覆盖 worker 域），wasm 字节经 bridge 保留信道回传时两侧用本实现，
// 不依赖任何全局垫片的安装时序。

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** 字节归一为 Uint8Array（ArrayBuffer / 带偏移的 TypedArray 通用） */
function asUint8(bytes: ArrayBuffer | Uint8Array): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

/** 字节 → base64 文本（块级累积防栈溢出；2.8MB jolt wasm 实测量级安全） */
export function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = asUint8(bytes);
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) {
    const end = Math.min(i + chunk, view.length);
    let sub = "";
    for (let j = i; j < end; j++) {
      sub += String.fromCharCode(view[j]);
    }
    out += sub;
  }
  let b64 = "";
  for (let i = 0; i < out.length; i += 3) {
    const b0 = out.charCodeAt(i);
    const b1 = i + 1 < out.length ? out.charCodeAt(i + 1) : 0;
    const b2 = i + 2 < out.length ? out.charCodeAt(i + 2) : 0;
    b64 += CHARS[b0 >> 2];
    b64 += CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    b64 += i + 1 < out.length ? CHARS[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    b64 += i + 2 < out.length ? CHARS[b2 & 63] : "=";
  }
  return b64;
}

/** base64 文本 → 字节（宽松解码：忽略非法字符与空白） */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const len = clean.length;
  const pad = len % 4 === 0 ? (clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0) : 0;
  const out = new Uint8Array(Math.floor((len * 3) / 4) - pad);
  let buffer = 0;
  let bits = 0;
  let p = 0;
  for (let i = 0; i < len; i++) {
    buffer = (buffer << 6) | CHARS.indexOf(clean[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (p < out.length) out[p++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}
