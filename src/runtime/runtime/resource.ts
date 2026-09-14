// 统一资源加载器：所有资源（模型/贴图/音频/材质/着色器/动画）经此加载。
// 支持来源优先级：AssetBundle → fetch（相对路径或 HTTP 绝对 URL）。
// 内置缓存（按 URL+类型 去重），installAssetShim 兼容保留（fetch 回退时仍经拦截）。

import { AssetBundle } from "./asset-bundle";

/** 加载类型 */
export type LoadType = "arrayBuffer" | "text" | "json" | "blob";

/** 统一资源加载器：按 URL 路由加载，AssetBundle 优先，未命中走 fetch。
 *  缓存按 `type|url` 去重；失败清除缓存允许重试。 */
export class ResourceLoader {
  private _cache = new Map<string, Promise<any>>();
  private _bundle: AssetBundle | null = null;

  /** 设置当前 AssetBundle（load 时优先从 bundle 取） */
  setBundle(bundle: AssetBundle | null): void {
    this._bundle = bundle;
  }

  /** 当前 bundle */
  get bundle(): AssetBundle | null {
    return this._bundle;
  }

  /** 加载二进制（ArrayBuffer） */
  async loadArrayBuffer(url: string): Promise<ArrayBuffer> {
    return this._load(url, "arrayBuffer");
  }

  /** 加载文本 */
  async loadText(url: string): Promise<string> {
    return this._load(url, "text");
  }

  /** 加载 JSON */
  async loadJSON<T = any>(url: string): Promise<T> {
    return this._load(url, "json");
  }

  /** 加载 Blob */
  async loadBlob(url: string): Promise<Blob> {
    return this._load(url, "blob");
  }

  /** 加载 ImageBitmap（flipY 翻转，贴图用） */
  async loadImageBitmap(url: string, flipY = true): Promise<ImageBitmap> {
    const blob = await this.loadBlob(url);
    return createImageBitmap(blob, flipY ? { imageOrientation: "flipY" } : {});
  }

  /** 核心：按类型加载，bundle 优先 */
  private async _load(url: string, type: LoadType): Promise<any> {
    const key = `${type}|${url}`;
    const cached = this._cache.get(key);
    if (cached) return cached;
    const p = this._doLoad(url, type);
    this._cache.set(key, p);
    p.catch(() => this._cache.delete(key));
    return p;
  }

  private async _doLoad(url: string, type: LoadType): Promise<any> {
    // 1) AssetBundle 优先（尝试多种路径归一化）
    if (this._bundle) {
      const data = this._bundle.tryGet(url);
      if (data) return this._decode(data, type);
    }
    // 2) fetch（installAssetShim 仍可能生效）
    const r = await fetch(url);
    if (!r.ok) throw new Error(`资源加载失败: HTTP ${r.status} (${url})`);
    switch (type) {
      case "arrayBuffer":
        return r.arrayBuffer();
      case "text":
        return r.text();
      case "json":
        return r.json();
      case "blob":
        return r.blob();
    }
  }

  /** 从 Uint8Array 按类型解码 */
  private _decode(data: Uint8Array, type: LoadType): any {
    switch (type) {
      case "arrayBuffer":
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      case "text":
        return new TextDecoder().decode(data);
      case "json":
        return JSON.parse(new TextDecoder().decode(data));
      case "blob":
        return new Blob([data]);
    }
  }

  /** 预加载多个资源（失败不中断） */
  async preload(urls: string[], type: LoadType = "arrayBuffer"): Promise<void> {
    await Promise.all(urls.map((u) => this._load(u, type).catch(() => {})));
  }

  /** 释放单个资源（所有类型） */
  unload(url: string): void {
    for (const key of this._cache.keys()) {
      if (key.endsWith(`|${url}`)) this._cache.delete(key);
    }
  }

  /** 清空所有缓存 */
  clear(): void {
    this._cache.clear();
  }
}

/** 全局单例（player.mjs 初始化时设置 bundle；各模块导入使用） */
export const resourceLoader = new ResourceLoader();