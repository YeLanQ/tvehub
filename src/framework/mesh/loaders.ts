// ---------------------------------------------------------------------------
// 模型加载器工厂（注册表模式）：
// - 每种模型格式对应一个 ModelLoaderDef：扩展名集合 + 解析函数；
// - 输入是 ArrayBuffer（应用层经 asset:// 协议直读二进制），
//   模型引用的外部资源（贴图/.bin）经 ctx.manager 的 URL 修饰器解析为
//   同目录文件的 asset:// URL（浏览器按需向 Rust 流式请求，见 ModelManager）；
// - 需要新格式（如 .dae/.ply）时：写一个 def 并在 createDefaultModelLoaderRegistry
//   里 register 一行即可。
// ---------------------------------------------------------------------------

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";

/** 单次模型解析的上下文（外部资源解析规则由 ModelManager 注入） */
export interface ModelLoadContext {
  /** 带资源 URL 修饰器的 LoadingManager（相对资源名 → 同目录 data URL） */
  manager: THREE.LoadingManager;
  /** 模型所在目录的“虚拟资源根”（与资产相对路径同构，如 "assets/models/"） */
  resourcePath: string;
}

/** 加载结果：模型根对象 + 内嵌动画剪辑（骨骼动画数据随剪辑携带） */
export interface LoadedModelData {
  object: THREE.Object3D;
  clips: THREE.AnimationClip[];
}

/** 单个模型格式的加载器定义（工厂产物 = 模型根对象 + 动画剪辑） */
export interface ModelLoaderDef {
  /** 格式 key（展示/诊断用） */
  key: string;
  /** UI 显示名 */
  label: string;
  /** 可解析的扩展名（小写） */
  exts: string[];
  /** 工厂：把二进制内容解析为 three 对象（失败 reject，含可读错误） */
  load(buffer: ArrayBuffer, ctx: ModelLoadContext): Promise<LoadedModelData>;
}

/** 模型加载器注册表：扩展名 → 加载器定义 */
export class ModelLoaderRegistry {
  private defs = new Map<string, ModelLoaderDef>();
  private byExt = new Map<string, ModelLoaderDef>();

  register(def: ModelLoaderDef): void {
    this.defs.set(def.key, def);
    for (const ext of def.exts) this.byExt.set(ext, def);
  }

  /** 按扩展名取加载器；未注册返回 null（ModelManager 记为加载失败） */
  resolveByExt(ext: string): ModelLoaderDef | null {
    return this.byExt.get(ext.toLowerCase()) ?? null;
  }

  /** 已注册格式列表（UI/诊断用） */
  list(): ModelLoaderDef[] {
    return [...this.defs.values()];
  }
}

// ---------------------------------------------------------------------------
// glTF / GLB：three GLTFLoader.parse。动画 = gltf.animations（骨骼动画内嵌）。
// 外部 .bin/贴图由 URL 修饰器解析；DRACO/KTX2 压缩资源未配置解码器，
// 遇到会在 onError 中给出可读提示。
// ---------------------------------------------------------------------------

const GLTF_DEF: ModelLoaderDef = {
  key: "gltf",
  label: "glTF",
  exts: ["gltf", "glb"],
  load: (buffer, ctx) =>
    new Promise<LoadedModelData>((resolve, reject) => {
      const loader = new GLTFLoader(ctx.manager);
      loader.parse(
        buffer,
        ctx.resourcePath,
        (gltf) => resolve({ object: gltf.scene, clips: gltf.animations ?? [] }),
        (err) =>
          reject(
            new Error(
              `glTF 解析失败: ${String(err ?? "未知错误")}（DRACO/KTX2 压缩模型暂不支持）`,
            ),
          ),
      );
    }),
};

// ---------------------------------------------------------------------------
// FBX：three FBXLoader.parse（同步返回 Group，动画挂 obj.animations）。
// FBX 内嵌贴图走 manager 的 URL 修饰器；外部贴图按同目录文件名匹配。
// ---------------------------------------------------------------------------

const FBX_DEF: ModelLoaderDef = {
  key: "fbx",
  label: "FBX",
  exts: ["fbx"],
  load: async (buffer, ctx) => {
    const loader = new FBXLoader(ctx.manager);
    const object = loader.parse(buffer, ctx.resourcePath);
    return { object, clips: (object as THREE.Group).animations ?? [] };
  },
};

// ---------------------------------------------------------------------------
// OBJ：three OBJLoader.parse（静态几何，无动画；材质为默认 Phong，
// 可在导出方先转 glTF 获得完整材质/动画）。
// ---------------------------------------------------------------------------

const OBJ_DEF: ModelLoaderDef = {
  key: "obj",
  label: "OBJ",
  exts: ["obj"],
  load: async (buffer, ctx) => {
    const loader = new OBJLoader(ctx.manager);
    const text = new TextDecoder().decode(buffer);
    const object = loader.parse(text);
    return { object, clips: [] };
  },
};

/** 默认加载器注册表（glTF/GLB + FBX + OBJ；新格式在此追加一行 register） */
export function createDefaultModelLoaderRegistry(): ModelLoaderRegistry {
  const registry = new ModelLoaderRegistry();
  registry.register(GLTF_DEF);
  registry.register(FBX_DEF);
  registry.register(OBJ_DEF);
  return registry;
}

/** 模块级单例：加载器无状态，ModelManager 与 UI（格式提示）共用 */
export const modelLoaderRegistry = createDefaultModelLoaderRegistry();
