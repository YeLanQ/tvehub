// ---------------------------------------------------------------------------
// 模型资产缓存（引擎渲染用的“模型库”，风格对齐 material/MaterialManager）。
// 只负责“模型资产相对路径 → 已解析模型（根对象模板 + 动画剪辑 + 骨骼标记）”
// 的读取/解析/缓存；文件内容来源由应用层注入的 ModelFileAccess 提供。
//
// 实例化：每个网格节点拿到的是模板的 SkeletonUtils.clone 副本——
// 普通网格 clone 即可共享几何/材质，蒙皮网格必须用 SkeletonUtils.clone
// 重建骨骼绑定（否则所有实例共享同一副骨骼，动画互相串台）。
// 模板本身不入场景，仅作为克隆源持有。
// ---------------------------------------------------------------------------

import * as THREE from "three";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { logger } from "../../platform_abstraction/logger";
import { modelDirOf, modelExtOf, type ModelMaterialInfo, type ModelMeta } from "./types";
import { modelLoaderRegistry, type ModelLoadContext } from "./loaders";

/** 应用层注入的文件访问（base64 二进制 + 同目录清单；与纹理读取器同构） */
export interface ModelFileAccess {
  /** 读取二进制资产，返回 base64 文本；不存在/失败返回 null */
  readBinary(rel: string): Promise<string | null>;
  /** 列出目录内的资产相对路径（外部贴图/.bin 预读用） */
  listDir(dir: string): Promise<string[]>;
}

/** 模型资产变更回调（加载完成后引擎据此刷新引用节点） */
export type ModelChangeListener = (rel: string) => void;

type ModelStatus = "loading" | "ready" | "error";

/** 缓存条目：解析结果或失败原因 */
interface ModelEntry {
  rel: string;
  status: ModelStatus;
  /** 克隆模板（仅 ready 时非空；不入场景） */
  template: THREE.Object3D | null;
  clips: THREE.AnimationClip[];
  clipNames: string[];
  hasSkeleton: boolean;
  materials: ModelMaterialInfo[];
  error: string | null;
}

/** 可能被模型引用的外部资源扩展名（预读为 data URL 供 URL 修饰器同步命中） */
const SIBLING_EXTS = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "bin",
]);

const SIBLING_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  bin: "application/octet-stream",
};

export class ModelManager {
  private cache = new Map<string, ModelEntry>();
  private loading = new Set<string>();
  private access: ModelFileAccess | null = null;
  private listeners = new Set<ModelChangeListener>();

  setAccess(access: ModelFileAccess | null): void {
    this.access = access;
  }

  onChanged(l: ModelChangeListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private notify(rel: string): void {
    for (const l of this.listeners) l(rel);
  }

  /** 是否已解析完成（ready 才可实例化） */
  has(rel: string): boolean {
    return this.cache.get(rel)?.status === "ready";
  }

  /** 取缓存条目信息（未加载返回 null；UI 展示剪辑/骨骼/材质用） */
  metaFor(rel: string): ModelMeta | null {
    const e = this.cache.get(rel);
    if (!e || e.status !== "ready") return null;
    return { clips: [...e.clipNames], hasSkeleton: e.hasSkeleton, materials: [...e.materials] };
  }

  /** 模型内嵌动画剪辑名列表（未加载/无动画返回空；UI 下拉用） */
  clipsFor(rel: string): string[] {
    const e = this.cache.get(rel);
    return e && e.status === "ready" ? [...e.clipNames] : [];
  }

  /** 模型内嵌动画剪辑对象（未加载返回空；AnimationSystem 建 action 用） */
  animationsFor(rel: string): THREE.AnimationClip[] {
    const e = this.cache.get(rel);
    return e && e.status === "ready" ? [...e.clips] : [];
  }

  /** 模型加载失败原因（UI 提示用；未失败返回 null） */
  errorFor(rel: string): string | null {
    const e = this.cache.get(rel);
    return e?.status === "error" ? e.error : null;
  }

  /**
   * 实例化模型（同步）：ready 时返回模板的 SkeletonUtils.clone 副本
   * （几何/材质与模板共享，蒙皮骨骼独立）；未就绪返回 null（调用方先渲染占位体，
   * 加载完成后经 onChanged 刷新）。
   */
  instantiate(rel: string): THREE.Object3D | null {
    const e = this.cache.get(rel);
    if (!e || e.status !== "ready" || !e.template) return null;
    return skeletonClone(e.template);
  }

  /** 预取一组模型引用并解析入缓存（失败项记为 error 条目，不抛出） */
  async preload(rels: string[]): Promise<number> {
    if (!this.access) return 0;
    let loaded = 0;
    for (const rel of rels) {
      if (!rel || this.cache.has(rel) || this.loading.has(rel)) continue;
      this.loading.add(rel);
      try {
        const ok = await this.loadOne(rel);
        if (ok) loaded++;
      } catch (e) {
        this.cache.set(rel, {
          rel,
          status: "error",
          template: null,
          clips: [],
          clipNames: [],
          hasSkeleton: false,
          materials: [],
          error: String(e instanceof Error ? e.message : e),
        });
        logger.warn(`[model] 模型加载失败 ${rel}: ${String(e)}`);
        this.notify(rel);
      } finally {
        this.loading.delete(rel);
      }
    }
    return loaded;
  }

  /** 解析单个模型：读文件 → 预读同目录外部资源 → 加载器解析 → 记录模板 */
  private async loadOne(rel: string): Promise<boolean> {
    const access = this.access;
    if (!access) return false;
    const ext = modelExtOf(rel);
    const def = ext ? modelLoaderRegistry.resolveByExt(ext) : null;
    if (!def) throw new Error(`不支持的模型格式: ${rel}（支持 ${modelLoaderRegistry.list().map((d) => d.label).join("/")}）`);

    const b64 = await access.readBinary(rel);
    if (!b64) throw new Error("模型文件读取失败（不存在或为空）");
    const buffer = base64ToArrayBuffer(b64);

    // 预读同目录可能被引用的外部资源 → 虚拟 URL 表（URL 修饰器需同步返回）
    const dir = modelDirOf(rel);
    const vfs = await this.preloadSiblings(access, dir);
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      // 相对资源名（最后一个路径段）→ data URL；未命中放行原地址（加载器自行报缺资源）
      const name = decodeURIComponent(url.split(/[\\/]/).pop() ?? "").split("?")[0];
      const hit = vfs.get(name);
      return hit ?? url;
    });

    const ctx: ModelLoadContext = { manager, resourcePath: dir ? `${dir}/` : "" };
    const data = await def.load(buffer, ctx);

    // 阴影参与渲染（模型网格默认投影/受影，与编辑器光照体系一致）
    data.object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    let hasSkeleton = false;
    data.object.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) hasSkeleton = true;
    });
    const materials = collectMaterials(data.object);

    this.cache.set(rel, {
      rel,
      status: "ready",
      template: data.object,
      clips: data.clips,
      clipNames: data.clips.map((c) => c.name || "clip"),
      hasSkeleton,
      materials,
      error: null,
    });
    logger.info(`[model] 模型已加载 ${rel}（${data.clips.length} 个动画剪辑${hasSkeleton ? "，含骨骼" : ""}）`);
    this.notify(rel);
    return true;
  }

  /** 预读目录内可能被引用的外部资源（图片/.bin）为 data URL 表 */
  private async preloadSiblings(
    access: ModelFileAccess,
    dir: string,
  ): Promise<Map<string, string>> {
    const vfs = new Map<string, string>();
    if (!dir) return vfs;
    try {
      const files = await access.listDir(dir);
      const targets = files.filter((f) => {
        const dot = f.lastIndexOf(".");
        if (dot < 0) return false;
        return SIBLING_EXTS.has(f.slice(dot + 1).toLowerCase());
      });
      for (const f of targets) {
        const name = f.split("/").pop()!;
        const dot = name.lastIndexOf(".");
        const mime = SIBLING_MIME[name.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
        const b64 = await access.readBinary(f);
        if (b64) vfs.set(name, `data:${mime};base64,${b64}`);
      }
    } catch {
      // 清单读取失败：模型内嵌资源仍可解析，外部资源缺失由加载器报错
    }
    return vfs;
  }

  /** 丢弃单个缓存（资产被改动/删除后调用；引用节点回退占位体） */
  invalidate(rel: string): void {
    this.cache.delete(rel);
    this.notify(rel);
  }

  /** 已解析的引用路径列表（调试用） */
  loadedRels(): string[] {
    return [...this.cache.entries()].filter(([, e]) => e.status === "ready").map(([rel]) => rel);
  }

  clear(): void {
    this.cache.clear();
    this.loading.clear();
  }
}

/** base64 → ArrayBuffer（模型加载器吃二进制） */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** three 材质类型 → 可读标签（材质摘要展示用） */
function materialTypeLabel(m: THREE.Material): string {
  switch (m.type) {
    case "MeshStandardMaterial":
    case "MeshPhysicalMaterial":
      return "PBR";
    case "MeshBasicMaterial":
      return "Unlit";
    case "MeshToonMaterial":
      return "Toon";
    case "MeshPhongMaterial":
      return "Phong";
    case "MeshLambertMaterial":
      return "Lambert";
    default:
      return m.type.replace(/^Mesh|Material$/g, "") || m.type;
  }
}

/** 收集模型内嵌材质清单（按材质实例去重，保持出现顺序） */
function collectMaterials(root: THREE.Object3D): ModelMaterialInfo[] {
  const out: ModelMaterialInfo[] = [];
  const seen = new Set<THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      out.push({ name: m.name || "（未命名）", type: materialTypeLabel(m) });
    }
  });
  return out;
}
