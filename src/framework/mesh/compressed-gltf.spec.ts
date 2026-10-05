import { beforeEach, describe, expect, it, vi } from "vitest";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import type { DracoDecoderLike } from "./compressed-gltf";

// 压缩 glTF 解码器装配：默认路径（DRACOLoader 真身，web/编辑器）与注入路径
// （微信主线程内联实现，DracoDecoderLike 结构子集）。dracoLoader 是模块级单例，
// 每用例前 vi.resetModules() 重置模块注册表取独立求值（等价 node 侧 query 串
// 缓存击穿，见 bridge.spec.mjs；非行为伪造，不属 vi.mock 禁用面）。

beforeEach(() => {
  vi.resetModules();
});

const freshModule = () => import("./compressed-gltf");

const dracoLoaderOf = (loader: GLTFLoader): unknown =>
  (loader as unknown as { dracoLoader: unknown }).dracoLoader;

describe("setupCompressedGltfSupport / applyCompressedGltfSupport", () => {
  it("未 setup：apply 不挂 Draco（能力面保持 false）", async () => {
    const m = await freshModule();
    expect(m.compressedGltfSupport().draco).toBe(false);
    const gltf = new GLTFLoader();
    m.applyCompressedGltfSupport(gltf);
    expect(dracoLoaderOf(gltf)).toBeNull();
  });

  it("默认路径：DRACOLoader 真身接入 GLTFLoader", async () => {
    const m = await freshModule();
    m.setupCompressedGltfSupport({ dracoBase: "/decoders/draco/", basisBase: "/decoders/basis/" });
    expect(m.compressedGltfSupport().draco).toBe(true);
    const gltf = new GLTFLoader();
    m.applyCompressedGltfSupport(gltf);
    expect(dracoLoaderOf(gltf)).toBeInstanceOf(DRACOLoader);
  });

  it("注入路径：dracoDecoder 结构件直通 GLTFLoader（微信内联解码）", async () => {
    const m = await freshModule();
    const inline: DracoDecoderLike = {
      preload: () => undefined,
      decodeDracoFile: () => undefined,
      dispose: () => undefined,
    };
    m.setupCompressedGltfSupport({
      dracoBase: "/decoders/draco/",
      basisBase: "/decoders/basis/",
      dracoDecoder: inline,
    });
    expect(m.compressedGltfSupport().draco).toBe(true);
    const gltf = new GLTFLoader();
    m.applyCompressedGltfSupport(gltf);
    expect(dracoLoaderOf(gltf)).toBe(inline);
  });

  it("幂等：解码器装配后二次 setup 不替换既有实例", async () => {
    const m = await freshModule();
    m.setupCompressedGltfSupport({ dracoBase: "/a/", basisBase: "/b/" });
    const first = dracoLoaderOf(applyToFreshLoader(m));
    const inline: DracoDecoderLike = { preload: () => undefined, decodeDracoFile: () => undefined };
    m.setupCompressedGltfSupport({ dracoBase: "/x/", basisBase: "/y/", dracoDecoder: inline });
    const second = dracoLoaderOf(applyToFreshLoader(m));
    expect(second).toBe(first);
    expect(second).toBeInstanceOf(DRACOLoader);
  });
});

function applyToFreshLoader(m: Awaited<ReturnType<typeof freshModule>>): GLTFLoader {
  const gltf = new GLTFLoader();
  m.applyCompressedGltfSupport(gltf);
  return gltf;
}
