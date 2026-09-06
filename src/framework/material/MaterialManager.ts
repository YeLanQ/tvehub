// ---------------------------------------------------------------------------
// 材质参数解析器缓存（引擎同步渲染用的“材质库”）。
// 只负责“按引用路径 → 内存材质文档（类型 + 参数）”的缓存；读取与 .mat 解析
// 在后端完成（material_read），应用层注入文档读取器（MaterialDocFetcher）。
// ---------------------------------------------------------------------------

import {
  DEFAULT_MATERIAL_PARAMS,
  cloneMaterialParams,
  type MaterialParams,
} from "./types";
import { DEFAULT_MATERIAL_TYPE } from "./factory";

/** 解析后的材质文档（后端 material_read 返回形态） */
export interface MaterialDoc {
  name: string;
  type: string;
  params: MaterialParams;
}

/** 按材质资产相对路径读取解析后的材质文档；不存在/失败返回 null */
export type MaterialDocFetcher = (rel: string) => Promise<MaterialDoc | null>;

/** 材质参数变更回调（编辑保存后引擎据此刷新外观） */
export type MaterialChangeListener = (rel: string) => void;

export class MaterialManager {
  private cache = new Map<string, MaterialDoc>();
  private loading = new Set<string>();
  private fetcher: MaterialDocFetcher | null = null;
  private listeners = new Set<MaterialChangeListener>();

  setFetcher(f: MaterialDocFetcher | null): void {
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
    return cached ? cloneMaterialParams(cached.params) : cloneMaterialParams(DEFAULT_MATERIAL_PARAMS);
  }

  /**
   * 取材质类型（注册表 key）：已缓存返回文件声明的类型；
   * 未解析/缺失回退默认类型（physical）。
   */
  typeFor(rel: string): string {
    return this.cache.get(rel)?.type ?? DEFAULT_MATERIAL_TYPE;
  }

  /** 直接写入缓存（编辑保存后由应用层调用，触发变更回调）。
   * type 缺省时沿用已缓存类型（参数编辑不改类型）；未缓存回退默认类型。 */
  cachePut(rel: string, params: MaterialParams, type?: string): void {
    const prev = this.cache.get(rel);
    this.cache.set(rel, {
      name: prev?.name ?? rel.split("/").pop()?.replace(/\.[^.]+$/, "") ?? rel,
      type: type ?? prev?.type ?? DEFAULT_MATERIAL_TYPE,
      params: cloneMaterialParams(params),
    });
    this.notify(rel);
  }

  invalidate(rel: string): void {
    this.cache.delete(rel);
  }

  /** 预取一组材质引用并入缓存（失败项静默跳过，渲染回退默认参数） */
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
