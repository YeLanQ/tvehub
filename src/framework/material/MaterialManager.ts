// ---------------------------------------------------------------------------
// 材质参数解析器缓存（引擎同步渲染用的“材质库”）。
// 只负责“按引用路径 → 内存参数”的解析与缓存；内容来源（内置/项目文件）
// 由应用层注入的文本读取器提供（MaterialTextFetcher）。
// ---------------------------------------------------------------------------

import {
  DEFAULT_MATERIAL_PARAMS,
  cloneMaterialParams,
  type MaterialParams,
} from "./types";
import { parseMaterialFile } from "./materialFile";

/** 按材质资产相对路径读取其 .mat 文本；不存在/失败返回 null */
export type MaterialTextFetcher = (rel: string) => Promise<string | null>;

/** 材质参数变更回调（编辑保存后引擎据此刷新外观） */
export type MaterialChangeListener = (rel: string) => void;

export class MaterialManager {
  private cache = new Map<string, MaterialParams>();
  private loading = new Set<string>();
  private fetcher: MaterialTextFetcher | null = null;
  private listeners = new Set<MaterialChangeListener>();

  setFetcher(f: MaterialTextFetcher | null): void {
    this.fetcher = f;
  }

  onChanged(l: MaterialChangeListener): () => void {
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

  /**
   * 取材质参数（同步）：已缓存返回缓存副本；未解析先回退内置默认参数，
   * 渲染不会因异步读取而中断——场景装载前应先用 preload() 预取。
   */
  paramsFor(rel: string): MaterialParams {
    const cached = this.cache.get(rel);
    return cached ? cloneMaterialParams(cached) : cloneMaterialParams(DEFAULT_MATERIAL_PARAMS);
  }

  /** 直接写入缓存（编辑保存后由应用层调用，触发变更回调） */
  cachePut(rel: string, params: MaterialParams): void {
    this.cache.set(rel, cloneMaterialParams(params));
    this.notify(rel);
  }

  invalidate(rel: string): void {
    this.cache.delete(rel);
  }

  /** 预取一组材质引用并解析入缓存（失败项静默跳过，渲染回退默认参数） */
  async preload(rels: string[]): Promise<number> {
    if (!this.fetcher) return 0;
    let loaded = 0;
    for (const rel of rels) {
      if (!rel || this.cache.has(rel) || this.loading.has(rel)) continue;
      this.loading.add(rel);
      try {
        const text = await this.fetcher(rel);
        if (text != null) {
          const doc = parseMaterialFile(text);
          if (doc) {
            this.cache.set(rel, cloneMaterialParams(doc.params));
            loaded++;
          }
        }
      } catch {
        // 读取失败：保持默认参数
      } finally {
        this.loading.delete(rel);
      }
    }
    return loaded;
  }

  /** 重新读取单个引用（内容在磁盘被改动后调用） */
  async reload(rel: string): Promise<boolean> {
    if (!this.fetcher) return false;
    try {
      const text = await this.fetcher(rel);
      if (text == null) return false;
      const doc = parseMaterialFile(text);
      if (!doc) return false;
      this.cache.set(rel, cloneMaterialParams(doc.params));
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
