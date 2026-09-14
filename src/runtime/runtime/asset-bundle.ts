// AssetBundle：资源包（归档格式，复用现有 assets.gzip 帧格式）。
// loadBundle(url) 加载并解压 → get(path) 取资源字节 → unload() 释放。
// 支持 gzip 归档 / 内联 base64 / 内联 base64+gzip / 条目 Map 四种构造方式。

import { parseArchive, gunzip, base64ToBytes } from "./pak";

/** AssetBundle：内存资源包，按相对路径索引字节表。 */
export class AssetBundle {
  private _entries: Map<string, Uint8Array>;

  constructor(entries: Map<string, Uint8Array>) {
    this._entries = entries;
  }

  /** 从已解压的归档字节构造 */
  static fromArchive(bytes: Uint8Array): AssetBundle {
    return new AssetBundle(parseArchive(bytes));
  }

  /** 从 gzip 归档 URL 异步加载并构造 */
  static async loadGzip(url: string): Promise<AssetBundle> {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`AssetBundle 加载失败: HTTP ${r.status} (${url})`);
    const compressed = new Uint8Array(await r.arrayBuffer());
    const decompressed = await gunzip(compressed);
    return AssetBundle.fromArchive(decompressed);
  }

  /** 从内联 base64 数据构造（非压缩） */
  static fromBase64(b64: string): AssetBundle {
    return AssetBundle.fromArchive(base64ToBytes(b64));
  }

  /** 从内联 base64+gzip 数据异步构造 */
  static async fromBase64Gzip(b64: string): Promise<AssetBundle> {
    const bytes = await gunzip(base64ToBytes(b64));
    return AssetBundle.fromArchive(bytes);
  }

  /** 从 base64 资产表构造（单页内联模式：{ rel: base64 } → Map） */
  static fromBase64Map(table: Record<string, string>): AssetBundle {
    const map = new Map<string, Uint8Array>();
    for (const [rel, b64] of Object.entries(table)) map.set(rel, base64ToBytes(b64));
    return new AssetBundle(map);
  }

  /** 从条目 Map 构造 */
  static fromMap(map: Map<string, Uint8Array>): AssetBundle {
    return new AssetBundle(map);
  }

  /** 取资源字节（命中返回副本，未命中 null） */
  get(path: string): Uint8Array | null {
    const data = this._entries.get(path);
    return data ? data.slice() : null;
  }

  /** 尝试多种路径归一化取资源（与 installAssetShim 同策略）。
   *  模块传相对路径 "a/b.glb" → 尝试 "a/b.glb" + URL 解析后的 pathname 变体。 */
  tryGet(url: string): Uint8Array | null {
    // 1) 原样
    let hit = this._entries.get(url);
    if (hit) return hit.slice();
    // 2) URL 归一化（与 installAssetShim 同逻辑）
    try {
      const u = new URL(url, location.href);
      const path = decodeURIComponent(u.pathname);
      const key1 = path.replace(/^\/+/, "");
      hit = this._entries.get(key1);
      if (hit) return hit.slice();
      const base = location.pathname.replace(/[^/]*$/, "");
      if (path.startsWith(base)) {
        const key2 = path.slice(base.length).replace(/^\/+/, "");
        hit = this._entries.get(key2);
        if (hit) return hit.slice();
      }
    } catch {
      /* URL 解析失败 */
    }
    // 3) 去除 ./ 前缀
    if (url.startsWith("./")) {
      hit = this._entries.get(url.slice(2));
      if (hit) return hit.slice();
    }
    return null;
  }

  /** 是否包含某资源 */
  has(path: string): boolean {
    return this._entries.has(path);
  }

  /** 所有条目路径 */
  paths(): string[] {
    return Array.from(this._entries.keys());
  }

  /** 条目数 */
  get size(): number {
    return this._entries.size;
  }

  /** 内部条目表（供 installAssetShim 兼容 GLTFLoader 等内部 fetch 用） */
  get entries(): Map<string, Uint8Array> {
    return this._entries;
  }

  /** 释放 */
  unload(): void {
    this._entries.clear();
  }
}