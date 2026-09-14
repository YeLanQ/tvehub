// ---------------------------------------------------------------------------
// model-draco —— glTF/GLB 模型 Draco 压缩管线（@gltf-transform + draco3dgltf）。
// - compressDocument 是与 IO 无关的管线核心（冒烟测试在 Node 侧用 NodeIO 复跑）；
//   编辑器内用 WebIO：.glb 从内存字节读，.gltf 经 asset:// URL 读（外部 .bin/贴图
//   按「同目录 asset:// URL」解析——覆写 dirname/resolve，绕过内置作用域对空路径
//   段的拒绝：目录 URL 永远只作为前缀拼接，不会被单独请求）；
// - draco3dgltf 的 emscripten 模块以 wasmBinary 直传初始化（?url 导入由 Vite 复制
//   资产；打包后 scriptDirectory 失效，靠 locateFile 定位不可靠）；
// - draco() 自带几何量化（默认位宽 = WebGL 友好标准：位置14/法线10/UV12/颜色8/
//   通用12），已压缩的 primitive 自动跳过，重复执行安全。
// ---------------------------------------------------------------------------

import { WebIO, type Document, type PlatformIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { draco } from "@gltf-transform/functions";
import { createDecoderModule, createEncoderModule } from "draco3dgltf";
import decoderWasmUrl from "draco3dgltf/draco_decoder_gltf.wasm?url";
import encoderWasmUrl from "draco3dgltf/draco_encoder.wasm?url";
import { assetUrl } from "../../lib/asset-url";

/** 量化档位对应位宽（标准 = gltf-transform 默认；高精度 ≈ 几乎无损，体积略大） */
export const DRACO_QUALITY_PRESETS = {
  standard: {
    quantizePosition: 14,
    quantizeNormal: 10,
    quantizeTexcoord: 12,
    quantizeColor: 8,
    quantizeGeneric: 12,
  },
  high: {
    quantizePosition: 16,
    quantizeNormal: 12,
    quantizeTexcoord: 14,
    quantizeColor: 10,
    quantizeGeneric: 14,
  },
} as const;

export type DracoQuality = keyof typeof DRACO_QUALITY_PRESETS;

export interface DracoCompressOptions {
  /** Draco 编码速度 0（最慢，压缩率最高）–10（最快，压缩率最低） */
  speed: number;
  /** 量化档位 */
  quality: DracoQuality;
}

/** draco3d emscripten 模块单例（编码器 + 解码器；首次调用后复用） */
let dracoModules: Promise<{ encoder: unknown; decoder: unknown }> | null = null;

function getDracoModules(): Promise<{ encoder: unknown; decoder: unknown }> {
  dracoModules ??= (async () => {
    const [encoderWasm, decoderWasm] = await Promise.all(
      [encoderWasmUrl, decoderWasmUrl].map(async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Draco wasm 加载失败: ${url}`);
        return res.arrayBuffer();
      }),
    );
    const [encoder, decoder] = await Promise.all([
      createEncoderModule({ wasmBinary: encoderWasm }),
      createDecoderModule({ wasmBinary: decoderWasm }),
    ]);
    return { encoder, decoder };
  })();
  return dracoModules;
}

/**
 * 编辑器内 glTF IO：.gltf 的外部资源按 asset:// 同目录解析。
 * dirname 恒返回目录基路径、resolve 只做字符串拼接（基路径由调用方保证以 / 结尾），
 * readURI 沿用 WebIO 的 fetch 实现（resolve 产出的已是完整协议 URL）。
 */
class AssetDirWebIO extends WebIO {
  constructor(private readonly dirUrl: string) {
    super();
  }
  protected override dirname(_uri: string): string {
    return this.dirUrl;
  }
  protected override resolve(base: string, path: string): string {
    return base + path;
  }
}

/** 创建挂好压缩扩展与 draco3d 依赖的编辑器 IO（dirUrl：.gltf 所在目录的 asset:// URL） */
export async function createBrowserModelIO(dirUrl?: string): Promise<PlatformIO> {
  const io: PlatformIO = dirUrl ? new AssetDirWebIO(dirUrl) : new WebIO();
  io.registerExtensions(ALL_EXTENSIONS);
  const { encoder, decoder } = await getDracoModules();
  io.registerDependencies({ "draco3d.encoder": encoder, "draco3d.decoder": decoder });
  return io;
}

/**
 * 管线核心：Document → Draco 压缩 → GLB 字节（IO 已挂好扩展与依赖，可复用）。
 * 动画/节点/贴图不压缩（Draco 只作用于网格几何）；已压缩 primitive 跳过。
 */
export async function compressDocument(
  doc: Document,
  opts: DracoCompressOptions,
  io: PlatformIO,
): Promise<Uint8Array> {
  await doc.transform(
    draco({
      method: "edgebreaker",
      encodeSpeed: opts.speed,
      decodeSpeed: opts.speed,
      ...DRACO_QUALITY_PRESETS[opts.quality],
    }),
  );
  return io.writeBinary(doc);
}

/** 压缩结果（供 UI 展示前后对比） */
export interface DracoCompressResult {
  /** 压缩产物 GLB 字节 */
  bytes: Uint8Array;
  originalSize: number;
  compressedSize: number;
}

/**
 * 压缩模型资产（编辑器 UI 入口），产物为自包含 GLB（外部贴图/.bin 一并内嵌）：
 * - glb：调用方传已拉取的字节（自包含，无外部资源）；
 * - gltf：经 asset:// URL 读取，外部 .bin/贴图按「同目录 asset:// URL」解析
 *   （dirUrl = 所在目录的 asset:// URL，以 / 结尾）。
 */
export async function compressModelToDraco(
  source:
    | { ext: "glb"; bytes: Uint8Array; originalSize: number }
    | { ext: "gltf"; rel: string; dirUrl: string; originalSize: number },
  opts: DracoCompressOptions,
): Promise<DracoCompressResult> {
  const io = await createBrowserModelIO(source.ext === "gltf" ? source.dirUrl : undefined);
  const doc =
    source.ext === "glb" ? await io.readBinary(source.bytes) : await io.read(assetUrl(source.rel));
  const bytes = await compressDocument(doc, opts, io);
  return { bytes, originalSize: source.originalSize, compressedSize: bytes.byteLength };
}

/** Uint8Array → base64（分块拼接，供 write_asset_binary 的 IPC 通道） */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
