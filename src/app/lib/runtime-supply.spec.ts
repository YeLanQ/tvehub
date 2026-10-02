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
});
