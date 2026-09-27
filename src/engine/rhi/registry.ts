// ---------------------------------------------------------------------------
// RHI 后端注册表：设备工厂的注册与解析（与 physics/backend/factory.ts 同一
// 模式——引擎无关词汇表 + 后端工厂注册）。
//
// registry 本身不 import 任何后端：three 等具体实现由消费方（编辑器
// RendererManager / 运行时 stage）显式 register，保证按需加载与可替换。
// auto 策略：优先 WebGPU，创建失败自动回退 WebGL（与既有的编辑器/运行时
// 双端行为一致）。
// ---------------------------------------------------------------------------

import type {
  RHIActiveBackend,
  RHIBackendKind,
  RHIDevice,
  RHIDeviceFactory,
  RHIDeviceOptions,
} from "./types";

const factories = new Map<RHIActiveBackend, RHIDeviceFactory>();

/** 注册某后端的设备工厂（同名重复注册以最后一次为准；测试可注入桩工厂） */
export function registerRHIDevice(kind: RHIActiveBackend, factory: RHIDeviceFactory): void {
  factories.set(kind, factory);
}

/** 已注册的后端清单（诊断/测试用） */
export function registeredRHIDeviceKinds(): RHIActiveBackend[] {
  return [...factories.keys()];
}

/** 清空注册表（仅测试用：隔离用例间的工厂注入） */
export function resetRHIDeviceRegistry(): void {
  factories.clear();
}

/**
 * 创建渲染设备：
 * - "webgl" → WebGL 工厂（失败即抛错——它本身是兜底层）；
 * - "webgpu" / "auto" → WebGPU 工厂（构造/init 失败回退 WebGL，warn 提示）。
 */
export async function createRHIDevice(
  kind: RHIBackendKind,
  options: RHIDeviceOptions = {},
): Promise<RHIDevice> {
  const prefer: RHIActiveBackend = kind === "auto" ? "webgpu" : kind;
  if (prefer === "webgpu") {
    const factory = factories.get("webgpu");
    if (factory) {
      try {
        return await factory(options);
      } catch (e) {
        console.warn(`[rhi] WebGPU 设备创建失败（${String(e)}），已回退 WebGL`);
      }
    }
  }
  const webgl = factories.get("webgl");
  if (!webgl) {
    throw new Error(`[rhi] 后端未注册：${kind}（webgl 兜底缺失）`);
  }
  return webgl(options);
}
