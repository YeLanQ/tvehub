// RHI three 后端注册入口：显式幂等注册（registry 保持零后端依赖，
// 消费方按需调用——未选 WebGPU 的产物不加载 three/webgpu）。
import { registerRHIDevice } from "../../registry";
import { createThreeWebGLDevice } from "./webgl";
import { createThreeWebGPUDevice } from "./webgpu";

let registered = false;

/** 注册 three 的 WebGL / WebGPU 设备工厂（重复调用无副作用） */
export function registerThreeRHIBackends(): void {
  if (registered) return;
  registered = true;
  registerRHIDevice("webgl", createThreeWebGLDevice);
  registerRHIDevice("webgpu", createThreeWebGPUDevice);
}
