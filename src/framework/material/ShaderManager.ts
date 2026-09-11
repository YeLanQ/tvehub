// ---------------------------------------------------------------------------
// 着色器文档缓存（着色器资产 rel → 解析后的文档）。
// 与 MaterialManager 同构：读取/解析在后端（shader_read：Rust 解析 Base/Hook/属性表），
// 本类只做「按引用缓存 + 变更广播」，应用层注入读取器。
// 引擎渲染网格时按 .mat 的 shader 引用同步取文档：渲染分支（Base）用于选材质类型，
// 钩子数据用于注入；文档加载完成/被改写后广播 onChanged，引擎据此刷新引用它的网格。
// ---------------------------------------------------------------------------

import type { ShaderDoc } from "./shader";

/** 按着色器资产相对路径读取解析后的文档；不存在/失败返回 null */
export type ShaderDocFetcher = (rel: string) => Promise<ShaderDoc | null>;

/** 着色器文档变更回调（源码保存/首次加载完成后触发） */
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

  /** 着色器文档（未解析返回 null） */
  docFor(rel: string): ShaderDoc | null {
    return this.cache.get(rel) ?? null;
  }

  /** 直接写入缓存（源码保存后由应用层调用，触发变更回调） */
  cachePut(rel: string, doc: ShaderDoc): void {
    this.cache.set(rel, doc);
    this.notify(rel);
  }

  /** 预取一组着色器引用（失败项静默跳过） */
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
        // 读取失败：保持未解析
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
