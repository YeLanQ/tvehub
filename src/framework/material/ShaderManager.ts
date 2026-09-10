// ---------------------------------------------------------------------------
// 着色器程序缓存（着色器资产 rel → 解析后的文档）。
// 与 MaterialManager 同构：读取/解析在后端（shader_read：Rust 解析 ShaderLab
// 并组装顶点/片元程序），本类只做「按引用缓存 + 变更广播」，应用层注入读取器。
// 引擎渲染网格时按 .mat 的 shader 引用同步取程序；程序加载完成/被改写后
// 广播 onChanged，引擎据此刷新引用该着色器的全部网格。
// ---------------------------------------------------------------------------

import type { ShaderDoc } from "./shader";

/** 按着色器资产相对路径读取解析后的文档；不存在/失败返回 null */
export type ShaderDocFetcher = (rel: string) => Promise<ShaderDoc | null>;

/** 着色器程序变更回调（源码保存/首次加载完成后触发） */
export type ShaderChangeListener = (rel: string) => void;

export class ShaderManager {
  private cache = new Map<string, ShaderDoc>();
  private loading = new Set<string>();
  private fetcher: ShaderDocFetcher | null = null;
  private listeners = new Set<ShaderChangeListener>();

  setFetcher(f: ShaderDocFetcher | null): void {
    this.fetcher = f;
  }

  onChanged(l: ShaderChangeListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private notify(rel: string): void {
    for (const l of this.listeners) l(rel);
  }

  /** 是否已解析到该引用 */
  has(rel: string): boolean {
    return this.cache.has(rel);
  }

  /** 着色器文档（未解析返回 null；渲染按占位程序回退） */
  docFor(rel: string): ShaderDoc | null {
    return this.cache.get(rel) ?? null;
  }

  /** 自定义着色器程序（未解析/非自定义/组装失败返回 null） */
  programFor(rel: string): ShaderDoc["program"] {
    return this.cache.get(rel)?.program ?? null;
  }

  /** 自定义着色器属性表（材质面板参数分组用；未解析返回空表） */
  propertiesFor(rel: string): ShaderDoc["properties"] {
    return this.cache.get(rel)?.properties ?? [];
  }

  /** 组装错误（null = 无错误/未解析） */
  errorFor(rel: string): string | null {
    return this.cache.get(rel)?.error ?? null;
  }

  /** 直接写入缓存（源码保存后由应用层调用，触发变更回调） */
  cachePut(rel: string, doc: ShaderDoc): void {
    this.cache.set(rel, doc);
    this.notify(rel);
  }

  /** 预取一组着色器引用（失败项静默跳过，渲染回退占位程序） */
  async preload(rels: string[]): Promise<number> {
    if (!this.fetcher) return 0;
    let loaded = 0;
    for (const rel of rels) {
      if (!rel || this.cache.has(rel) || this.loading.has(rel)) continue;
      this.loading.add(rel);
      try {
        const doc = await this.fetcher(rel);
        if (doc) {
          this.cache.set(rel, doc);
          loaded++;
        }
      } catch {
        // 读取失败：保持未解析（渲染占位程序）
      } finally {
        this.loading.delete(rel);
      }
    }
    return loaded;
  }

  /** 重新读取单个引用（源码保存/磁盘改动后调用），并广播变更 */
  async reload(rel: string): Promise<boolean> {
    if (!this.fetcher) return false;
    try {
      const doc = await this.fetcher(rel);
      if (!doc) return false;
      this.cache.set(rel, doc);
      this.notify(rel);
      return true;
    } catch {
      return false;
    }
  }

  /** 已解析的引用路径列表（调试/导出用） */
  loadedRels(): string[] {
    return [...this.cache.keys()];
  }

  clear(): void {
    this.cache.clear();
    this.loading.clear();
  }
}
