// ---------------------------------------------------------------------------
// RHI（Render Hardware Interface）类型定义：设备无关的渲染硬件抽象。
//
// 本文件不 import three（或任何第三方渲染库）——接口只使用原生类型与
// 不透明载荷（object）。具体图形后端的差异（WebGL / WebGPU / 第三方库
// 版本）全部封装在 backends/ 下的设备实现里；上层（RPI / Framework /
// App / Runtime）只依赖本模块的类型与 registry 提供的工厂。
//
// scene / camera 以不透明载荷（object）穿过 RHI：场景图的组织与解释权在
// RPI/Framework 的场景层，RHI 只负责把它交给后端绘制。替换渲染后端时，
// 仅需重写 backends/ 目录，本文件与上层代码不动。
// ---------------------------------------------------------------------------

/** 期望的后端（auto = 优先 WebGPU，失败自动回退 WebGL） */
export type RHIBackendKind = "webgl" | "webgpu" | "auto";

/** 实际生效的后端（auto 解析后的落点） */
export type RHIActiveBackend = "webgl" | "webgpu";

/** 色调映射（HDR 合成策略；由后端映射到具体枚举值） */
export type RHIToneMapping = "none" | "aces-filmic";

/** 阴影过滤模式（当前两种后端统一按 PCF 采样，保留扩展位） */
export type RHIShadowFilter = "pcf";

/** GPU 功耗偏好 */
export type RHIPowerPreference = "default" | "high-performance" | "low-power";

/** 着色器编译失败摘要（WebGL debug 钩子；WebGPU 后端无此钩子） */
export interface RHIShaderError {
  message: string;
}

/** 设备创建选项（表面/上下文参数；跨帧保留缓冲、MSAA、功耗偏好） */
export interface RHIDeviceOptions {
  /** MSAA 抗锯齿开关 */
  antialias?: boolean;
  /** MSAA 精确采样数（antialias=true 时生效；WebGPU 侧使用） */
  msaaSamples?: number;
  /** 跨帧保留绘制缓冲（仅清深度/仅清颜色标志需要保留上一帧画面） */
  preserveDrawingBuffer?: boolean;
  powerPreference?: RHIPowerPreference;
  /**
   * 注入画布（重建设备复用首画布）：微信等平台首画布归首渲染器，重建时若不传，
   * 后端自建画布会落到平台离屏链（渲染到屏外 = 黑屏）。传旧设备 domElement 让
   * 新渲染器接管同一画布（同类型 getContext 返回既有上下文，dispose 不强杀）。
   */
  canvas?: HTMLCanvasElement;
  /** 着色器编译失败回调（接编辑器控制台/引擎事件） */
  onShaderError?: (error: RHIShaderError) => void;
}

/** 显示配置（像素比/色调映射/阴影；任意子集，缺省项不动） */
export interface RHIDisplayConfig {
  pixelRatio?: number;
  toneMapping?: RHIToneMapping;
  shadowMapEnabled?: boolean;
  shadowFilter?: RHIShadowFilter;
}

/** 渲染统计快照（调试面板；WebGPU 下部分字段可能为 0） */
export interface RHIRenderStats {
  drawCalls: number;
  triangles: number;
  lines: number;
  points: number;
  geometries: number;
  textures: number;
  programs: number;
}

/** 离屏渲染目标纹理格式 */
export type RHITargetFormat = "half-float" | "unsigned-byte";

/** 渲染目标描述 */
export interface RHIRenderTargetDesc {
  width: number;
  height: number;
  format?: RHITargetFormat;
  /** MSAA 采样数（0 = 关闭） */
  samples?: number;
  depthBuffer?: boolean;
}

/** 渲染目标句柄（后端资源的不透明包装；texture 供回贴/采样） */
export interface RHIRenderTarget {
  readonly desc: RHIRenderTargetDesc;
  /** 目标颜色附件纹理载荷（后端解释） */
  readonly texture: unknown;
  /** 后端原生对象（RHI 内部与遗留路径使用，勿在上层扩散） */
  readonly handle: unknown;
  resize(width: number, height: number): void;
  dispose(): void;
}

/** 矩形（视口/裁剪；逻辑像素，后端内部处理像素比换算） */
export interface RHIRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 渲染设备：RHI 的核心接口。屏蔽 WebGL/WebGPU 与第三方渲染库的差异，
* 向上提供统一的设备操作面（创建/配置/渲染/离屏目标/统计/销毁）。
 */
export interface RHIDevice {
  /** 实际生效的后端（auto 请求解析后的落点） */
  readonly kind: RHIActiveBackend;
  readonly domElement: HTMLCanvasElement;
  /** 后端原生对象（遗留 WebGL 专属路径的逃生口；新代码不得依赖） */
  readonly native: unknown;

  configureDisplay(config: RHIDisplayConfig): void;
  setPixelRatio(value: number): void;
  getPixelRatio(): number;
  setSize(width: number, height: number, updateStyle?: boolean): void;

  /** 渲染一帧（scene/camera 为不透明载荷，由场景层持有） */
  render(scene: object, camera: object): void;
  /** 着色器预热（WebGL 同步 compile；WebGPU 异步 compileAsync） */
  warmupShaders(scene: object, camera: object): unknown | Promise<unknown>;

  /** 每帧渲染时的自动清屏标志（仅颜色/仅深度清除的组合基础） */
  setAutoClear(color: boolean, depth: boolean): void;

  setShadowMapEnabled(enabled: boolean): void;
  /** 阴影图按需重画策略：autoUpdate=false 且按 needsUpdate 重画一次 */
  setShadowMapOnDemand(needsUpdate: boolean): void;

  createRenderTarget(desc: RHIRenderTargetDesc): RHIRenderTarget;
  setRenderTarget(target: RHIRenderTarget | null): void;

  setViewport(rect: RHIRect): void;
  setScissor(rect: RHIRect): void;
  setScissorTest(test: boolean): void;

  getStats(): RHIRenderStats;
  dispose(): void;
}

/** 设备工厂（异步：WebGPU 设备需要 await init()） */
export type RHIDeviceFactory = (options: RHIDeviceOptions) => Promise<RHIDevice>;
