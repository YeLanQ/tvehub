// ---------------------------------------------------------------------------
// RHI three 后端 · WebGPU 设备：three/webgpu 的 WebGPURenderer 适配。
// 动态加载（构建体积大，仅选中 WebGPU 时进入页面）；init 失败抛错由
// registry 兜底回退 WebGL。渲染目标与 WebGL 设备共用（three core 互用）。
// ---------------------------------------------------------------------------

import * as THREE from "three";
import { ThreeRenderTarget } from "./renderTarget";
import type {
  RHIDevice,
  RHIDeviceOptions,
  RHIDisplayConfig,
  RHIRect,
  RHIRenderStats,
  RHIRenderTarget,
  RHIRenderTargetDesc,
} from "../../types";

/** WebGPURenderer 的结构化最小面（three/webgpu 无公开类型，按使用面声明） */
interface WebGPURendererLike {
  readonly domElement: HTMLCanvasElement;
  toneMapping: number;
  autoClearColor: boolean;
  autoClearDepth: boolean;
  shadowMap: {
    enabled: boolean;
    type: number;
    autoUpdate?: boolean;
    needsUpdate?: boolean;
  };
  info?: {
    render?: { calls?: number; triangles?: number; lines?: number; points?: number };
    memory?: { geometries?: number; textures?: number };
    programs?: unknown[];
  };
  init(): Promise<void>;
  setPixelRatio(value?: number): void;
  getPixelRatio(): number;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  render(scene: object, camera: object): void;
  compileAsync(scene: object, camera: object): Promise<unknown>;
  setRenderTarget(target: unknown): void;
  setViewport(x: number, y: number, w: number, h: number): void;
  setScissor(x: number, y: number, w: number, h: number): void;
  setScissorTest(test: boolean): void;
  dispose(): void;
}

/** 创建 WebGPU 设备（three/webgpu 的 WebGPURenderer；失败抛错→registry 回退） */
export async function createThreeWebGPUDevice(options: RHIDeviceOptions): Promise<RHIDevice> {
  const mod = (await import("three/webgpu")) as unknown as {
    WebGPURenderer?: unknown;
    default?: unknown;
  };
  const Ctor = mod.WebGPURenderer ?? mod.default;
  if (typeof Ctor !== "function") throw new Error("WebGPURenderer not exported");
  // powerPreference 仅在 macOS/Linux 被采纳；Windows 上 requestAdapter 忽略
  // （Chromium crbug.com/369219127），仍传递以求在支持的平台生效
  const renderer = new (Ctor as new (params?: {
    forceWebGL?: boolean;
    antialias?: boolean;
    samples?: number;
    powerPreference?: string;
  }) => WebGPURendererLike)({
    forceWebGL: false,
    antialias: options.antialias === true,
    samples: options.antialias === true ? (options.msaaSamples ?? 0) : 0,
    powerPreference: options.powerPreference ?? "default",
  });
  // WebGPU 后端为异步初始化：必须先 await init() 再 render()（WebGL 无此要求）
  await renderer.init();
  let pixelRatio = renderer.getPixelRatio();

  const device: RHIDevice = {
    kind: "webgpu",
    domElement: renderer.domElement,
    native: renderer,
    configureDisplay(config: RHIDisplayConfig): void {
      if (config.pixelRatio !== undefined) {
        pixelRatio = config.pixelRatio;
        renderer.setPixelRatio(pixelRatio);
      }
      if (config.toneMapping !== undefined) {
        renderer.toneMapping =
          config.toneMapping === "aces-filmic" ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
      }
      if (config.shadowMapEnabled !== undefined) renderer.shadowMap.enabled = config.shadowMapEnabled;
      if (config.shadowFilter !== undefined) renderer.shadowMap.type = THREE.PCFShadowMap;
    },
    setPixelRatio(value: number): void {
      pixelRatio = value;
      renderer.setPixelRatio(value);
    },
    getPixelRatio(): number {
      return pixelRatio;
    },
    setSize(width: number, height: number, updateStyle?: boolean): void {
      renderer.setSize(width, height, updateStyle);
    },
    render(scene: object, camera: object): void {
      renderer.render(scene, camera);
    },
    warmupShaders(scene: object, camera: object): Promise<unknown> {
      return renderer.compileAsync(scene, camera);
    },
    setAutoClear(color: boolean, depth: boolean): void {
      renderer.autoClearColor = color;
      renderer.autoClearDepth = depth;
    },
    setShadowMapEnabled(enabled: boolean): void {
      renderer.shadowMap.enabled = enabled;
    },
    setShadowMapOnDemand(needsUpdate: boolean): void {
      // three/webgpu 的阴影刷新表无 autoUpdate 细粒度开关时按需重画标记
      if (renderer.shadowMap.autoUpdate !== undefined) renderer.shadowMap.autoUpdate = false;
      if (renderer.shadowMap.needsUpdate !== undefined) renderer.shadowMap.needsUpdate = needsUpdate;
    },
    createRenderTarget(desc: RHIRenderTargetDesc): RHIRenderTarget {
      const rt = new THREE.RenderTarget(desc.width, desc.height, {
        type: desc.format === "half-float" ? THREE.HalfFloatType : THREE.UnsignedByteType,
        samples: desc.samples ?? 0,
        depthBuffer: desc.depthBuffer !== false,
      });
      return new ThreeRenderTarget(rt);
    },
    setRenderTarget(target: RHIRenderTarget | null): void {
      renderer.setRenderTarget(target ? target.handle : null);
    },
    setViewport(rect: RHIRect): void {
      renderer.setViewport(rect.x, rect.y, rect.width, rect.height);
    },
    setScissor(rect: RHIRect): void {
      renderer.setScissor(rect.x, rect.y, rect.width, rect.height);
    },
    setScissorTest(test: boolean): void {
      renderer.setScissorTest(test);
    },
    getStats(): RHIRenderStats {
      const info = renderer.info;
      return {
        drawCalls: info?.render?.calls ?? 0,
        triangles: info?.render?.triangles ?? 0,
        lines: info?.render?.lines ?? 0,
        points: info?.render?.points ?? 0,
        geometries: info?.memory?.geometries ?? 0,
        textures: info?.memory?.textures ?? 0,
        programs: info?.programs?.length ?? 0,
      };
    },
    dispose(): void {
      renderer.dispose();
    },
  };
  return device;
}
