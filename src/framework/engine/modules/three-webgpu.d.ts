// three/webgpu（WebGPURenderer）的类型声明。
// 安装的 @types/three 未覆盖 "three/webgpu" 构建入口，这里只声明编辑器用到的最小 API，
// 运行时以动态 import 拉取，避免类型缺失报错。
import type { Camera, Scene } from "three";

declare module "three/webgpu" {
  export class WebGPURenderer {
    readonly domElement: HTMLCanvasElement;
    shadowMap: { enabled: boolean; type: number; transmitted?: boolean };
    constructor(parameters?: { forceWebGL?: boolean });
    setPixelRatio(value?: number): void;
    setSize(width: number, height: number, updateStyle?: boolean): void;
    render(scene: Scene, camera: Camera): void;
    dispose(): void;
  }
}
