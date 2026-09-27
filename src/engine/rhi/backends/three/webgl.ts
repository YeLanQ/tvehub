// ---------------------------------------------------------------------------
// RHI three 后端 · WebGL 设备：THREE.WebGLRenderer 的 RHI 适配。
// 渲染器创建/配置/渲染/离屏目标/统计的设备语义全部在此翻译成 three 调用，
// 上层只见 RHIDevice 接口。替换渲染后端时重写本目录即可。
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

/** 着色器编译失败摘要：取 fragment/vertex infoLog 前几行（编辑器控制台可读） */
function shaderErrorSummary(
  context: { getShaderInfoLog(s: unknown): string | null },
  vs: unknown,
  fs: unknown,
): string {
  const log = context.getShaderInfoLog(fs) || context.getShaderInfoLog(vs) || "";
  const summary = String(log).trim().split("\n").slice(0, 4).join(" / ");
  return summary || "着色器编译失败（无详细信息）";
}

/** 创建 WebGL 设备（three WebGLRenderer） */
export async function createThreeWebGLDevice(options: RHIDeviceOptions): Promise<RHIDevice> {
  // preserveDrawingBuffer：仅深度/仅颜色清除标志需要跨帧保留颜色/深度缓冲
  // （WebGL 默认呈现后缓冲失效，不清颜色会退化成黑屏/花屏）
  const renderer = new THREE.WebGLRenderer({
    antialias: options.antialias === true,
    preserveDrawingBuffer: options.preserveDrawingBuffer === true,
    powerPreference: options.powerPreference ?? "default",
  });
  // 着色器编译失败（扩展着色器 GLSL 有误等）：three 默认只打印浏览器控制台，
  // 这里显式接出摘要到回调（引擎事件 → 编辑器控制台）
  if (options.onShaderError) {
    const cb = options.onShaderError;
    renderer.debug.onShaderError = (context, _program, vs, fs) => {
      cb({ message: shaderErrorSummary(context as never, vs, fs) });
    };
  }
  let pixelRatio = renderer.getPixelRatio();

  const device: RHIDevice = {
    kind: "webgl",
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
      renderer.render(scene as THREE.Object3D, camera as THREE.Camera);
    },
    warmupShaders(scene: object, camera: object): unknown {
      return renderer.compile(scene as THREE.Object3D, camera as THREE.Camera);
    },
    setAutoClear(color: boolean, depth: boolean): void {
      renderer.autoClearColor = color;
      renderer.autoClearDepth = depth;
    },
    setShadowMapEnabled(enabled: boolean): void {
      renderer.shadowMap.enabled = enabled;
    },
    setShadowMapOnDemand(needsUpdate: boolean): void {
      // 静态场景阴影图按需重画：关闭每帧自动重画，脏标记时重画一次
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = needsUpdate;
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
      // three 类型面要求 WebGLRenderTarget；RT 由本后端创建（见 createRenderTarget）
      renderer.setRenderTarget(
        (target ? target.handle : null) as THREE.WebGLRenderTarget | null,
      );
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
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
        lines: info.render.lines,
        points: info.render.points,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        programs: info.programs?.length ?? 0,
      };
    },
    dispose(): void {
      renderer.dispose();
    },
  };
  return device;
}
