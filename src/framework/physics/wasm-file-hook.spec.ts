// ---------------------------------------------------------------------------
// wasm 文件化装载钩子：安装幂等（已有安装方优先）、主线程按文档地址解析相对
// wasm 路径、fetch 非 2xx 报错透出、字节经 WebAssembly.instantiate 返回
// {module, instance}。（jsdom：location 存在、无 WorkerGlobalScope → 主线程分支）
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from "vitest";
import { installWasmFileHook } from "./wasm-file-hook";

type Hook = (path: string, imports: WebAssembly.Imports) => Promise<WebAssembly.WebAssemblyInstantiatedSource>;

function globalHook(): Hook | undefined {
  return (globalThis as unknown as { __tveInstantiateWasmFile?: Hook }).__tveInstantiateWasmFile;
}

/** 最小 wasm 二进制（合法空模块，\0asm + 版本 1） */
const EMPTY_WASM = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);

const originalHook = globalHook();
const originalFetch = globalThis.fetch;

afterEach(() => {
  (globalThis as unknown as { __tveInstantiateWasmFile?: Hook }).__tveInstantiateWasmFile = originalHook;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("installWasmFileHook", () => {
  it("正常：安装后可经文档地址解析相对 wasm 路径并实例化", async () => {
    delete (globalThis as unknown as { __tveInstantiateWasmFile?: Hook }).__tveInstantiateWasmFile;
    installWasmFileHook();
    const hook = globalHook();
    expect(hook).toBeTypeOf("function");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(EMPTY_WASM, { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await hook!("engine/runtime/physics-engines/rapier.wasm", {});
    expect(result.instance).toBeInstanceOf(WebAssembly.Instance);
    expect(result.module).toBeInstanceOf(WebAssembly.Module);
    // jsdom location.origin + 相对路径解析（首页根形态）
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toContain("engine/runtime/physics-engines/rapier.wasm");
  });

  it("幂等：已安装的钩子不被覆盖（微信桥接等先行安装方优先）", () => {
    const existing = vi.fn();
    (globalThis as unknown as { __tveInstantiateWasmFile?: Hook }).__tveInstantiateWasmFile =
      existing as unknown as Hook;
    installWasmFileHook();
    expect(globalHook()).toBe(existing);
  });

  it("异常：fetch 非 2xx 时透出错误（含路径与状态码）", async () => {
    delete (globalThis as unknown as { __tveInstantiateWasmFile?: Hook }).__tveInstantiateWasmFile;
    installWasmFileHook();
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const hook = globalHook();
    await expect(hook!("engine/x.wasm", {})).rejects.toThrow(/404/);
  });
});
