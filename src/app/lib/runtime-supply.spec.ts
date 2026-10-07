// ---------------------------------------------------------------------------
// 渠道运行时供给 · wechat 物理分支（按后端随包 + 未知后端回退）：
// 以 fetch 桩喂入清单条目文本，断言 files map 的物理引擎键集合。
// ---------------------------------------------------------------------------

import { afterAll, describe, expect, it } from "vitest";
import { fetchChannelRuntimeFiles } from "./runtime-supply";

const originalFetch = globalThis.fetch;

/** fetch 桩：任何 URL 返回 ok + 占位文本（清单 key 组装逻辑是测试对象）；
 *  .wasm 走 arrayBuffer 形态（Rust 侧按 .wasm 键 base64 解码） */
function stubRuntimeFetch(): void {
  globalThis.fetch = ((url: string | URL | Request) => {
    void url;
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve("// stub"),
      arrayBuffer: () => Promise.resolve(new Uint8Array([0, 0x61, 0x73, 0x6d]).buffer),
    } as unknown as Response);
  }) as unknown as typeof fetch;
}

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function runtimeKeys(files: Record<string, string>): string[] {
  return Object.keys(files).filter((k) => k.startsWith("engine/runtime/physics-engines/"));
}

describe("fetchChannelRuntimeFiles wechat 物理供给", () => {
  it("正常：jolt 后端随包 jolt 引擎产物（不含其他后端）", async () => {
    stubRuntimeFetch();
    const files = await fetchChannelRuntimeFiles("wechat", {
      includePhysics: true,
      physicsBackend: "jolt",
    });
    const engines = runtimeKeys(files);
    expect(engines).toContain("engine/runtime/physics-engines/jolt.js");
    expect(engines).not.toContain("engine/runtime/physics-engines/rapier.js");
    expect(engines).not.toContain("engine/runtime/physics-engines/ammo/ammo-esm.js");
  });

  it("正常：ammo 后端随包 ammo 产物目录", async () => {
    stubRuntimeFetch();
    const files = await fetchChannelRuntimeFiles("wechat", {
      includePhysics: true,
      physicsBackend: "ammo",
    });
    expect(runtimeKeys(files)).toContain("engine/runtime/physics-engines/ammo/ammo-esm.js");
  });

  it("正常：rapier 后端随包 rapier 产物（缺省行为不变）", async () => {
    stubRuntimeFetch();
    const files = await fetchChannelRuntimeFiles("wechat", {
      includePhysics: true,
      physicsBackend: "rapier",
    });
    expect(runtimeKeys(files)).toContain("engine/runtime/physics-engines/rapier.js");
    // .wasm 二进制以 base64 进 files map（Rust 侧解码写盘）
    expect(files["engine/runtime/physics-engines/rapier.wasm"]).toBe("AGFzbQ==");
  });

  it("边界：物理未启用时不随任何物理引擎", async () => {
    stubRuntimeFetch();
    const files = await fetchChannelRuntimeFiles("wechat", { includePhysics: false });
    expect(runtimeKeys(files)).toHaveLength(0);
  });

  it("异常：未知后端回退 rapier（与 web 渠道同规则）", async () => {
    stubRuntimeFetch();
    const files = await fetchChannelRuntimeFiles("wechat", {
      includePhysics: true,
      physicsBackend: "physx",
    });
    const engines = runtimeKeys(files);
    expect(engines).toContain("engine/runtime/physics-engines/rapier.js");
    expect(engines).not.toContain("engine/runtime/physics-engines/jolt.js");
  });

  it("正常：物理启用随包物理 Worker bundle（改键 workers/tve.js，同后端同选）", async () => {
    stubRuntimeFetch();
    const files = await fetchChannelRuntimeFiles("wechat", {
      includePhysics: true,
      physicsBackend: "jolt",
    });
    // wx.createWorker 入口路径恒定：按后端拉取的 workers/jolt/tve.js 改键落盘
    expect(files["workers/tve.js"]).toBe("// stub");
    expect(Object.keys(files).some((k) => k.startsWith("workers/jolt/"))).toBe(false);
    // 物理未启用时 worker bundle 不随包（无 workers/ 键）
    const disabled = await fetchChannelRuntimeFiles("wechat", { includePhysics: false });
    expect(Object.keys(disabled).some((k) => k.startsWith("workers/"))).toBe(false);
  });

  it("正常：仅动画（无物理）随包 Worker bundle，引擎胶水不随（动画路由免 wasm）", async () => {
    stubRuntimeFetch();
    const files = await fetchChannelRuntimeFiles("wechat", {
      includePhysics: false,
      includeAnimationWorker: true,
    });
    expect(files["workers/tve.js"]).toBe("// stub");
    // 骨骼动画在 worker 内为纯数学代理，无需引擎 wasm → 物理引擎产物整组缺省
    expect(runtimeKeys(files)).toHaveLength(0);
  });

  it("正常：启用 Draco 压缩随包 wasm 解码器（wrapper JS + .wasm，与物理/Worker 无关独立生效）", async () => {
    stubRuntimeFetch();
    const files = await fetchChannelRuntimeFiles("wechat", { includeDracoDecoder: true });
    expect(Object.keys(files)).toContain("engine/runtime/loaders/draco/draco_wasm_wrapper.js");
    // .wasm 二进制以 base64 进 files map（Rust 侧解码写盘，与 web 渠道同形态）
    expect(files["engine/runtime/loaders/draco/draco_decoder.wasm"]).toBe("AGFzbQ==");
    // Draco 与物理互不连带：不开物理不随引擎产物与 Worker bundle
    expect(runtimeKeys(files)).toHaveLength(0);
    expect(Object.keys(files).some((k) => k.startsWith("workers/"))).toBe(false);
  });

  it("边界：未启用 Draco 时包内不随解码器（base 清单无 loaders/draco/）", async () => {
    stubRuntimeFetch();
    const files = await fetchChannelRuntimeFiles("wechat", {});
    expect(Object.keys(files).some((k) => k.includes("loaders/draco/"))).toBe(false);
  });
});

describe("fetchChannelRuntimeFiles web 可选运行时", () => {
  it("正常：物理启用随当前后端引擎（胶水 + .wasm 以 base64 进 files map）", async () => {
    stubRuntimeFetch();
    const files = await fetchChannelRuntimeFiles("web", {
      includePhysics: true,
      physicsBackend: "rapier",
    });
    const engines = runtimeKeys(files);
    expect(engines).toContain("engine/runtime/physics-engines/rapier.mjs");
    expect(engines).toContain("engine/runtime/physics-engines/rapier.wasm");
    expect(files["engine/runtime/physics-engines/rapier.wasm"]).toBe("AGFzbQ==");
    expect(engines).not.toContain("engine/runtime/physics-engines/jolt.mjs");
  });

  it("正常：启用 Draco 压缩随 wasm 解码器（wrapper JS + .wasm）", async () => {
    stubRuntimeFetch();
    const files = await fetchChannelRuntimeFiles("web", { includeDracoDecoder: true });
    expect(Object.keys(files)).toContain("engine/runtime/loaders/draco/draco_wasm_wrapper.js");
    expect(Object.keys(files)).toContain("engine/runtime/loaders/draco/draco_decoder.wasm");
    expect(files["engine/runtime/loaders/draco/draco_decoder.wasm"]).toBe("AGFzbQ==");
  });

  it("边界：未启用任何可选运行时只随 base 清单（解码器/物理引擎不随）", async () => {
    stubRuntimeFetch();
    const files = await fetchChannelRuntimeFiles("web", {});
    const keys = Object.keys(files);
    expect(runtimeKeys(files)).toHaveLength(0);
    expect(keys.some((k) => k.includes("loaders/draco/"))).toBe(false);
    expect(keys.some((k) => k.includes("loaders/basis/"))).toBe(false);
  });
});
