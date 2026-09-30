// 桥接核心 · URL / URLSearchParams：相对解析以 locationShim 为基准（全内联架构下
// 消费面 = pak 的 fetch shim 与 asset-bundle 的键归一化，覆盖 pathname/search/origin）。

import { bridgeActive } from "./host.ts";
import { setGlobal } from "./install.ts";

class URLSearchParamsShim {
  constructor(init) {
    this._map = new Map();
    if (typeof init === "string") {
      const q = init.startsWith("?") ? init.slice(1) : init;
      for (const pair of q.split("&")) {
        if (!pair) continue;
        const eq = pair.indexOf("=");
        const key = eq < 0 ? pair : pair.slice(0, eq);
        this.append(decodePlus(key), eq < 0 ? "" : decodePlus(pair.slice(eq + 1)));
      }
    } else if (init && typeof init === "object") {
      for (const [k, v] of init) this.append(String(k), String(v));
    }
  }

  append(key, value) {
    const list = this._map.get(key) || [];
    list.push(value);
    this._map.set(key, list);
  }

  get(key) {
    const list = this._map.get(String(key));
    return list && list.length ? list[0] : null;
  }

  has(key) {
    return this._map.has(String(key));
  }

  *entries() {
    for (const [k, list] of this._map) for (const v of list) yield [k, v];
  }

  toString() {
    return [...this.entries()].map(([k, v]) => `${encodePlus(k)}=${encodePlus(v)}`).join("&");
  }
}

function decodePlus(s) {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

function encodePlus(s) {
  return encodeURIComponent(String(s)).replace(/%20/g, "+");
}

const ABSOLUTE_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(\/\/[^/?#]*)?([^?#]*)(\?[^#]*)?(#[\s\S]*)?$/;

class URLShim {
  constructor(url, base) {
    const raw = String(url ?? "");
    let merged = raw;
    if (base && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) && !raw.startsWith("data:")) {
      merged = resolveRelative(raw, String(base));
    }
    const m = ABSOLUTE_RE.exec(merged);
    if (!m) {
      this.protocol = "";
      this.host = "";
      this.hostname = "";
      this.origin = "";
      this.pathname = raw;
      this.search = "";
      this.hash = "";
      this.href = raw;
    } else {
      this.protocol = m[1] || "";
      const authority = m[2] ? m[2].slice(2) : "";
      const at = authority.lastIndexOf("@");
      const hostPart = at >= 0 ? authority.slice(at + 1) : authority;
      const colon = hostPart.lastIndexOf(":");
      this.hostname = colon >= 0 ? hostPart.slice(0, colon) : hostPart;
      this.port = colon >= 0 ? hostPart.slice(colon + 1) : "";
      this.host = hostPart;
      this.origin = m[2] ? `${m[1]}//${hostPart}` : "";
      this.pathname = m[3] || "/";
      this.search = m[4] || "";
      this.hash = m[5] || "";
      this.href = merged;
    }
    this.searchParams = new URLSearchParamsShim(this.search);
    this.username = "";
    this.password = "";
  }

  toString() {
    return this.href;
  }

  toJSON() {
    return this.href;
  }
}

function resolveRelative(raw, base) {
  if (raw.startsWith("//")) {
    const m = ABSOLUTE_RE.exec(base);
    return m && m[1] ? m[1] + raw : raw;
  }
  const m = ABSOLUTE_RE.exec(base);
  if (!m || !m[1]) return raw;
  const origin = m[2] ? m[1] + m[2] : "";
  const [pathPart, tail] = splitQueryHash(raw);
  if (raw.startsWith("/")) return origin + pathPart + tail;
  const baseDir = (m[3] || "/").slice(0, (m[3] || "/").lastIndexOf("/") + 1);
  return origin + joinPath(baseDir, pathPart) + tail;
}

function splitQueryHash(raw) {
  const i = raw.search(/[?#]/);
  return i < 0 ? [raw, ""] : [raw.slice(0, i), raw.slice(i)];
}

function joinPath(dir, rel) {
  const parts = (dir + rel).split("/");
  const out = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return "/" + out.join("/");
}

export function installUrlGlobals() {
  if (!bridgeActive()) return;
  setGlobal("URL", URLShim);
  setGlobal("URLSearchParams", URLSearchParamsShim);
  return { URLShim, URLSearchParamsShim };
}

// 求值期安装（bootstrap 以 import 装配，见该文件说明）
installUrlGlobals();

export { URLShim, URLSearchParamsShim };
