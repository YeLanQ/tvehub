import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRHIDevice,
  registerRHIDevice,
  registeredRHIDeviceKinds,
  resetRHIDeviceRegistry,
} from "./registry";
import type { RHIDevice, RHIDeviceFactory } from "./types";

/** 桩设备（不触碰真实 GPU；记录创建参数供断言） */
function fakeDevice(kind: "webgl" | "webgpu", options: unknown): RHIDevice {
  return {
    kind,
    domElement: document.createElement("canvas"),
    native: { kind, options },
    configureDisplay: () => {},
    setPixelRatio: () => {},
    getPixelRatio: () => 1,
    setSize: () => {},
    render: () => {},
    warmupShaders: () => undefined,
    setAutoClear: () => {},
    setShadowMapEnabled: () => {},
    setShadowMapOnDemand: () => {},
    createRenderTarget: (() => null) as never,
    setRenderTarget: () => {},
    setViewport: () => {},
    setScissor: () => {},
    setScissorTest: () => {},
    getStats: () => ({
      drawCalls: 0,
      triangles: 0,
      lines: 0,
      points: 0,
      geometries: 0,
      textures: 0,
      programs: 0,
    }),
    dispose: () => {},
  };
}

function okFactory(kind: "webgl" | "webgpu"): RHIDeviceFactory {
  return async (options) => fakeDevice(kind, options);
}

describe("RHI 后端注册表", () => {
  beforeEach(() => {
    resetRHIDeviceRegistry();
  });
  afterEach(() => {
    resetRHIDeviceRegistry();
  });

  it("注册后可列出后端清单，webgl 直连创建", async () => {
    registerRHIDevice("webgl", okFactory("webgl"));
    expect(registeredRHIDeviceKinds()).toEqual(["webgl"]);
    const device = await createRHIDevice("webgl", { antialias: true });
    expect(device.kind).toBe("webgl");
  });

  it("auto：WebGPU 可用时优先创建 WebGPU 设备", async () => {
    registerRHIDevice("webgl", okFactory("webgl"));
    registerRHIDevice("webgpu", okFactory("webgpu"));
    const device = await createRHIDevice("auto", {});
    expect(device.kind).toBe("webgpu");
  });

  it("WebGPU 构造失败（init 抛错）自动回退 WebGL", async () => {
    registerRHIDevice("webgl", okFactory("webgl"));
    registerRHIDevice("webgpu", async () => {
      throw new Error("adapter 不可用");
    });
    const device = await createRHIDevice("webgpu", {});
    expect(device.kind).toBe("webgl");
  });

  it("auto：WebGPU 后端未注册时直接落 WebGL", async () => {
    registerRHIDevice("webgl", okFactory("webgl"));
    const device = await createRHIDevice("auto", {});
    expect(device.kind).toBe("webgl");
  });

  it("webgl 兜底缺失：直连 webgl 请求抛错；auto 在 webgpu 可用时仍成功", async () => {
    registerRHIDevice("webgpu", okFactory("webgpu"));
    await expect(createRHIDevice("webgl", {})).rejects.toThrow("后端未注册");
    const device = await createRHIDevice("auto", {});
    expect(device.kind).toBe("webgpu");
  });

  it("两个后端都缺失时任何请求都抛错", async () => {
    await expect(createRHIDevice("auto", {})).rejects.toThrow("后端未注册");
    await expect(createRHIDevice("webgl", {})).rejects.toThrow("后端未注册");
  });

  it("创建选项透传给工厂（antialias/功耗偏好等）", async () => {
    let received: unknown = null;
    registerRHIDevice("webgl", async (options) => {
      received = options;
      return fakeDevice("webgl", options);
    });
    await createRHIDevice("webgl", { antialias: true, powerPreference: "low-power" });
    expect(received).toMatchObject({ antialias: true, powerPreference: "low-power" });
  });

  it("重复注册同一后端以最后一次为准（测试可覆盖注入）", async () => {
    registerRHIDevice("webgl", okFactory("webgl"));
    registerRHIDevice("webgl", okFactory("webgl"));
    expect(registeredRHIDeviceKinds()).toEqual(["webgl"]);
    const device = await createRHIDevice("webgl", {});
    expect(device.kind).toBe("webgl");
  });
});
