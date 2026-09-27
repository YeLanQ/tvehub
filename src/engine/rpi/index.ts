// RPI 公共出口：管线类型 + 分层 pass 纯逻辑 + 管线工厂。
// 纯逻辑（types/layerSet）零 three 依赖；具体管线实现在 backends/ 下。
import type { RHIDevice } from "../rhi";
import { createThreePipeline } from "./backends/three/pipeline";
import type { RPIPipeline } from "./types";

export * from "./types";
export * from "./layerSet";

/**
 * 创建渲染管线：按 RHI 设备的实际后端分派实现。
 * 当前唯一实现是 three 后端（WebGL/WebGPU 设备共用）；接入自研或其他
 * 渲染库后端时在此按 device.kind 增加分支，上层调用方零改动。
 */
export function createRPIPipeline(device: RHIDevice): RPIPipeline {
  return createThreePipeline(device);
}
