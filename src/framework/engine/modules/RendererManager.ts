import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export type RendererBackend = "webgl" | "webgpu" | "auto";

/** 编辑器视口默认清屏色（无天空盒节点时的场景背景） */
export const EDITOR_BACKGROUND_COLOR = 0x141414;

/** 与具体后端解耦的最小渲染器接口（WebGLRenderer / WebGPURenderer 共用） */
interface RendererHandle {
  domElement: HTMLCanvasElement;
  shadowMap: { enabled: boolean; type: number };
  toneMapping: number;
  /** 每帧是否清颜色/深度缓冲（两种后端语义一致；清除标志按帧改写） */
  autoClearColor: boolean;
  autoClearDepth: boolean;
  setPixelRatio(value?: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
  dispose(): void;
}

/**
 * 相机清除状态（渲染每帧开始时如何清屏；由引擎按活动相机节点的清除标志给出）：
 * - background：本帧 scene.background（null = 不绘制背景，配合不清颜色保留上一帧画面）；
 * - clearColor / clearDepth：是否清空颜色/深度缓冲。
 */
export interface CameraClearState {
  background: THREE.Texture | THREE.Color | null;
  clearColor: boolean;
  clearDepth: boolean;
}

/**
 * 渲染器管理：编辑器视口渲染。
 *
 * 渲染设计要点：
 * - 支持项目设置里选择的渲染后端（webgl / webgpu / auto）：
 *   - webgl → 经典 WebGLRenderer（默认、稳定）；
 *   - webgpu / auto → 动态 import three/webgpu 的 WebGPURenderer；three 0.185
 *     在 WebGPU 不可用时会自动回退 WebGL2 后端（内部 getFallback）；构造失败时
 *     这里再兜底回退 WebGLRenderer。运行时不可切换，修改后需重新挂载。
 * - 编辑器使用独立的自由轨道相机（editorCamera / OrbitControls）；
 * - 场景“真实渲染相机”（CameraNode 预览）是另一个独立相机，通过
 *   registerCamera / setActiveCamera 切换，互不影响；
 * - 视口尺寸变化不立即改画布：ResizeObserver 只记录目标尺寸，在渲染循环
 *   里与下一帧绘制同步执行 setSize，避免拖拽分隔条时出现黑闪；
 * - canvas CSS 恒为 100%，视觉上始终铺满容器。
 */
export class RendererManager {
  readonly scene = new THREE.Scene();
  camera!: THREE.PerspectiveCamera;
  private renderer!: RendererHandle;
  /** 实际生效的后端（webgl 或 webgpu），供日志/诊断 */
  activeBackend: RendererBackend | "webgpu" = "webgl";
  private orbit!: OrbitControls;
  private container!: HTMLElement;
  private raf = 0;
  private resizeObs?: ResizeObserver;
  private renderCb?: () => void;
  /** 清除状态提供方（引擎按活动相机节点的清除标志给出；缺省全清 + 全局背景） */
  private clearProvider: ((cam: THREE.Camera) => CameraClearState | null) | null = null;

  /** 所有需要随视口比例更新的相机（编辑器相机 + 预览相机等，透视/正交） */
  private cameras = new Set<THREE.Camera>();
  /** 相机宽高比更新钩子（正交相机按半高+宽高比重算左右/上下范围；缺省按透视 aspect 更新） */
  private cameraAspectSyncs = new Map<THREE.Camera, (aspect: number) => void>();
  /** 当前渲染使用的相机（默认编辑器相机） */
  private activeCamera: THREE.Camera | null = null;

  /** 容器期望尺寸（ResizeObserver 记录，渲染循环里再应用） */
  private targetW = 0;
  private targetH = 0;
  /** 已应用到画布的尺寸 */
  private appliedW = 0;
  private appliedH = 0;
  /** 渲染循环暂停（预览/脚本等中央区域被独立面板接管时暂停后台渲染） */
  private paused = false;

  async mount(
    container: HTMLElement,
    options?: {
      renderer?: RendererBackend;
      antialias?: number;
      hdrMode?: "hdr" | "ldr";
    },
  ): Promise<void> {
    this.container = container;
    const backend = options?.renderer ?? "webgl";
    const aa = Math.max(0, Math.min(8, Math.round(options?.antialias ?? 2)));
    this.renderer = await createRendererHandle(backend, aa, (actual) => {
      this.activeBackend = actual;
    });
    if (this.activeBackend !== "webgl") {
      console.info("[renderer] 渲染后端: WebGPU（WebGPU 不可用时 three 自动回退 WebGL2）");
    }
    // HDR/LDR 渲染合成：HDR 用 ACES 电影级色调映射，LDR 常规输出（不映射）
    this.renderer.toneMapping =
      (options?.hdrMode ?? "ldr") === "hdr"
        ? THREE.ACESFilmicToneMapping
        : THREE.NoToneMapping;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;

    const dom = this.renderer.domElement;
    dom.style.display = "block";
    dom.style.position = "absolute";
    dom.style.top = "0";
    dom.style.left = "0";
    // CSS 铺满容器：容器实时变化时画布视觉始终铺满，不会露出背景黑边
    dom.style.width = "100%";
    dom.style.height = "100%";
    container.appendChild(dom);

    this.scene.background = new THREE.Color(EDITOR_BACKGROUND_COLOR);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
    this.camera.position.set(6, 6, 9);

    this.orbit = new OrbitControls(this.camera, dom);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;

    dom.addEventListener("contextmenu", (e) => e.preventDefault(), { passive: false });
    dom.addEventListener("gesturestart", (e) => e.preventDefault(), { passive: false });
    dom.addEventListener("gesturechange", (e) => e.preventDefault(), { passive: false });
    dom.addEventListener("gestureend", (e) => e.preventDefault(), { passive: false });

    const grid = new THREE.GridHelper(40, 40, 0x3f3f3f, 0x262626);
    grid.name = "__grid";
    this.scene.add(grid);

    this.registerCamera(this.camera);
    this.activeCamera = this.camera;

    this.resizeObs = new ResizeObserver(() => this.scheduleResize());
    this.resizeObs.observe(container);
    this.scheduleResize();
    this.applySizeIfNeeded();
    this.loop();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObs?.disconnect();
    this.orbit?.dispose();
    if (this.renderer) {
      this.renderer.domElement.parentElement?.removeChild(this.renderer.domElement);
      this.renderer.dispose();
    }
  }

  setRenderCb(cb: () => void): void {
    this.renderCb = cb;
  }

  /** 注入清除状态提供方（每帧渲染前按活动相机调用；null 配置 = 保持默认全清与全局背景） */
  setClearProvider(provider: ((cam: THREE.Camera) => CameraClearState | null) | null): void {
    this.clearProvider = provider;
  }

  /**
   * 渲染前按活动相机应用清除标志：改写 scene.background 与 autoClear 标志。
   * background 由 provider 每帧给定（纯色/天空/无背景），与引擎的全局天空
   * 维护（applySkyFromGraph）不冲突：每帧重写，引擎侧仍是纹理的属主。
   */
  private applyClearState(cam: THREE.Camera): void {
    const r = this.renderer;
    if (!r) return;
    const state = this.clearProvider ? this.clearProvider(cam) : null;
    if (!state) {
      r.autoClearColor = true;
      r.autoClearDepth = true;
      return;
    }
    this.scene.background = state.background;
    r.autoClearColor = state.clearColor;
    r.autoClearDepth = state.clearDepth;
  }

  /** 暂停/恢复渲染循环（中央区域被 iframe/面板接管时暂停，避免后台空转） */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      cancelAnimationFrame(this.raf);
    } else {
      this.loop();
    }
  }

  /**
   * 注册需要跟随视口宽高比更新的相机。
   * onAspect：自定义比例更新（正交相机重算取景范围用）；缺省按透视相机 aspect 更新。
   */
  registerCamera(cam: THREE.Camera, onAspect?: (aspect: number) => void): void {
    this.cameras.add(cam);
    if (onAspect) this.cameraAspectSyncs.set(cam, onAspect);
    if (this.appliedW > 0 && this.appliedH > 0) {
      this.applyCameraAspect(cam, this.appliedW / this.appliedH);
    }
  }

  /** 切换当前渲染相机（编辑器相机 与 预览相机（透视/正交）之间切换） */
  setActiveCamera(cam: THREE.Camera): void {
    this.activeCamera = cam;
  }

  getActiveCamera(): THREE.Camera | null {
    return this.activeCamera;
  }

  /** 按相机形态应用新宽高比：有钩子走钩子；透视相机写 aspect 后更新投影 */
  private applyCameraAspect(cam: THREE.Camera, aspect: number): void {
    const sync = this.cameraAspectSyncs.get(cam);
    if (sync) {
      sync(aspect);
      return;
    }
    const persp = cam as THREE.PerspectiveCamera;
    if (persp.isPerspectiveCamera === true) {
      persp.aspect = aspect;
      persp.updateProjectionMatrix();
    }
  }

  /** ResizeObserver 回调：只记录目标尺寸，不在布局阶段触碰 WebGL 缓冲 */
  private scheduleResize = (): void => {
    if (!this.container) return;
    this.targetW = Math.max(1, this.container.clientWidth || 1);
    this.targetH = Math.max(1, this.container.clientHeight || 1);
  };

  /** 渲染循环内应用尺寸：改缓冲 + 更新所有相机宽高比后同帧立即渲染，避免黑闪 */
  private applySizeIfNeeded = (): void => {
    if (this.targetW === this.appliedW && this.targetH === this.appliedH) return;
    this.appliedW = this.targetW;
    this.appliedH = this.targetH;
    if (!this.renderer || this.appliedW < 1 || this.appliedH < 1) return;
    this.renderer.setSize(this.appliedW, this.appliedH, false);
    const aspect = this.appliedW / this.appliedH;
    this.cameras.forEach((c) => this.applyCameraAspect(c, aspect));
  };

  private loop = (): void => {
    if (this.paused) return;
    this.raf = requestAnimationFrame(this.loop);
    this.applySizeIfNeeded();
    this.orbit?.update();
    this.renderCb?.();
    if (this.renderer) {
      this.applyClearState(this.activeCamera ?? this.camera);
      this.renderer.render(this.scene, this.activeCamera ?? this.camera);
    }
  };

  get domElement(): HTMLElement {
    return this.renderer.domElement;
  }

  /** 原始 WebGL 渲染器（仅 webgl 后端；离屏渲染等特殊用途；其他后端返回 null） */
  get glRenderer(): THREE.WebGLRenderer | null {
    return this.activeBackend === "webgl"
      ? (this.renderer as unknown as THREE.WebGLRenderer)
      : null;
  }

  get orbitControls(): OrbitControls {
    return this.orbit;
  }

  /** 当前视口宽高比（辅助线等需要按视口比例绘制时使用） */
  get aspect(): number {
    if (this.appliedW > 0 && this.appliedH > 0) return this.appliedW / this.appliedH;
    return this.camera ? this.camera.aspect : 1;
  }
}

/**
 * 按后端创建渲染器：
 * - webgl → WebGLRenderer（稳定默认）；
 * - webgpu / auto → 动态加载 WebGPURenderer（three 内置 WebGL2 自动回退）；
 *   构造异常或模块不可用时兜底回退 WebGLRenderer。
 */
async function createRendererHandle(
  backend: RendererBackend,
  antialias: number,
  onCreated: (actual: RendererBackend | "webgpu") => void,
): Promise<RendererHandle> {
  const aa = antialias > 0;
  const fallback = (why?: string): RendererHandle => {
    if (why) console.warn(`[renderer] 使用 WebGLRenderer: ${why}`);
    onCreated("webgl");
    // preserveDrawingBuffer：仅深度/仅颜色清除标志需要跨帧保留颜色/深度缓冲
    // （WebGL 默认呈现后缓冲失效，不清颜色会退化成黑屏/花屏）
    return new THREE.WebGLRenderer({
      antialias: aa,
      preserveDrawingBuffer: true,
    }) as unknown as RendererHandle;
  };

  if (backend === "webgl") return fallback();

  try {
    const mod = (await import("three/webgpu")) as unknown as {
      WebGPURenderer?: unknown;
      default?: unknown;
    };
    const Ctor = mod.WebGPURenderer ?? mod.default;
    if (typeof Ctor !== "function") throw new Error("WebGPURenderer not exported");
    const instance = new (Ctor as new (params?: {
      forceWebGL?: boolean;
      antialias?: boolean;
      samples?: number;
    }) => unknown)({
      forceWebGL: false,
      antialias: aa,
      samples: aa ? antialias : 0,
    });
    // WebGPU 后端为异步初始化：必须先 await renderer.init() 再 render()（WebGL 无此要求）
    const maybeInit = instance as { init?: () => Promise<void> };
    if (typeof maybeInit.init === "function") {
      await maybeInit.init();
    }
    onCreated("webgpu");
    return instance as RendererHandle;
  } catch (e) {
    return fallback(`WebGPU 不可用或初始化失败（${String(e)}），已回退 WebGL2/WebGL`);
  }
}
