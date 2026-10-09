import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { createRHIDevice, type RHIDevice } from "../../../engine/rhi";
import { registerThreeRHIBackends } from "../../../engine/rhi/backends/three";
import { createRPIPipeline, type RPIClearDesc, type RPIPipeline } from "../../../engine/rpi";
import type { PiPRequest } from "./CameraPiP";
import { FrameRateLimiter } from "./frameLimiter";

export type RendererBackend = "webgl" | "webgpu" | "auto";

/** 编辑器视口默认清屏色（无天空盒节点时的场景背景） */
export const EDITOR_BACKGROUND_COLOR = 0x141414;

/** 空闲判定窗口：最后一次交互/场景活动后该毫秒数内保持全速渲染 */
const IDLE_DELAY_MS = 800;
/** 空闲视口帧率上限：视口静止（无交互且无活动内容）时的降频渲染目标 */
const IDLE_FPS = 12;
/** 活动视口帧率上限：高刷屏（120/144/165Hz）全速 rAF 是视口功耗/发热的直接
 *  来源——Bresenham 数帧锁 60（60Hz 屏全渲零回归），与播放器缺省帧率一致 */
const ACTIVE_FPS_CAP = 60;

/** 渲染统计快照（调试面板每帧/定时拉取） */
export interface RenderStats {
  fps: number;
  drawCalls: number;
  triangles: number;
  lines: number;
  points: number;
  geometries: number;
  textures: number;
  programs: number;
  meshes: number;
  vertices: number;
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
 * 渲染器管理：编辑器视口渲染（Framework 层渲染服务）。
 *
 * 渲染设计要点：
 * - 设备与管线经 RHI/RPI 抽象（src/engine）：RendererManager 只做编辑器
 *   策略（活动期锁 60 帧率上限/空闲降帧/尺寸同步节奏/阴影按需重画），不直接
 *   创建 three 渲染器——
 *   后端选择（webgl / webgpu / auto）由 RHI registry 解析（WebGPU 不可用
 *   自动回退 WebGL），多 pass/离屏/回贴流程由 RPI 管线承担。运行时不可
 *   切换，修改后需重新挂载；
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
  private device!: RHIDevice;
  private pipeline!: RPIPipeline;
  /** 实际生效的后端（webgl 或 webgpu），供日志/诊断与材质策略分派 */
  activeBackend: RendererBackend | "webgpu" = "webgl";
  /** 原始渲染设备载荷（RHI native；KTX2 压缩纹理格式探测等需要具体类型） */
  get raw(): unknown {
    return this.device?.native;
  }
  private orbit!: OrbitControls;
  private container!: HTMLElement;
  private raf = 0;
  private resizeObs?: ResizeObserver;
  private renderCb?: () => void;
  /** 清除状态提供方（引擎按活动相机节点的清除标志给出；缺省全清 + 全局背景） */
  private clearProvider: ((cam: THREE.Camera) => CameraClearState | null) | null = null;
  /** 画中画提供方（引擎按选中相机节点逐帧解析；null 配置 = 无画中画） */
  private pipProvider: ((viewW: number, viewH: number) => PiPRequest | null) | null = null;
  /** 着色器编译失败回调（three 的 program 报错 → 引擎事件 → 编辑器控制台） */
  private shaderErrorCb: ((message: string) => void) | null = null;
  /** UI 布局视图独占渲染钩子（begin 隐藏非画布子树返回数量；end 恢复；null = 无 UI） */
  private uiSoloCb: { begin(): number; end(): void } | null = null;

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

  /** 最近一次视口活动（交互输入/相机运动/场景活动钩子）时间戳——空闲降帧的基准 */
  private lastActivityAt = performance.now();
  /** 上一次空闲降帧渲染的时间戳 */
  private lastIdleRenderAt = 0;
  /** 活动期帧率配额（Bresenham 数帧；见 ACTIVE_FPS_CAP） */
  private activeLimiter = new FrameRateLimiter(ACTIVE_FPS_CAP);
  /** 场景活动谓词（引擎注入：动画播放中/粒子发射中/物理模拟中等返回 true 即保持全速） */
  private activityHooks: (() => boolean)[] = [];

  /** 渲染统计：FPS（EMA 平滑）+ 帧时间戳 */
  private statsFps = 0;
  private statsLastTime = 0;
  /** 场景遍历统计缓存（getStats 被拉取时按需更新；面板关闭 = 零遍历） */
  private statsMeshes = 0;
  private statsVertices = 0;
  private statsTraverseAt = 0;

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
    // 设备创建经 RHI：后端解析/WebGPU 初始化/失败回退 WebGL 全部在 registry，
    // 着色器编译失败摘要经 onShaderError 回调接出（three 默认只打印浏览器控制台）
    registerThreeRHIBackends();
    this.device = await createRHIDevice(backend, {
      antialias: aa > 0,
      msaaSamples: aa,
      // preserveDrawingBuffer：仅深度/仅颜色清除标志需要跨帧保留颜色/深度缓冲
      preserveDrawingBuffer: true,
      onShaderError: (e) => this.shaderErrorCb?.(e.message),
    });
    this.activeBackend = this.device.kind;
    this.pipeline = createRPIPipeline(this.device);
    if (this.activeBackend !== "webgl") {
      console.info("[renderer] 渲染后端: WebGPU（WebGPU 不可用时 three 自动回退 WebGL2）");
    }
    // HDR/LDR 渲染合成：HDR 用 ACES 电影级色调映射，LDR 常规输出（不映射）；
    // PCF 采样：每灯的 shadow.radius（Shadow 类型 Hard/Soft）只在 PCF 下生效，
    // PCFSoft 会忽略 radius，无法做每灯软硬差异
    this.device.configureDisplay({
      toneMapping: (options?.hdrMode ?? "ldr") === "hdr" ? "aces-filmic" : "none",
      pixelRatio: Math.min(window.devicePixelRatio, 2),
      shadowMapEnabled: true,
      shadowFilter: "pcf",
    });

    const dom = this.device.domElement;
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
    // 编辑器自由视角恒全层可见（节点可挂任意渲染层级；Culling Mask 只作用于
    // 场景中的相机节点预览，自由视角若跟随掩码会出现"对象凭空消失"）
    this.camera.layers.enableAll();

    this.orbit = new OrbitControls(this.camera, dom);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;

    // 空闲降帧的活动信号：任何视口输入与相机运动（含阻尼收敛期间）恢复全速渲染。
    // passive 监听只写时间戳，无分配；键盘挂 window（快捷键多在全局层）。
    const mark = (): void => this.markActivity();
    dom.addEventListener("pointerdown", mark, { passive: true });
    dom.addEventListener("pointermove", mark, { passive: true });
    dom.addEventListener("wheel", mark, { passive: true });
    window.addEventListener("keydown", mark, { passive: true });
    this.orbit.addEventListener("change", mark);

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
    this.pipeline?.dispose();
    if (this.device) {
      this.device.domElement.parentElement?.removeChild(this.device.domElement);
      this.device.dispose();
    }
  }

  setRenderCb(cb: () => void): void {
    this.renderCb = cb;
  }

  /** 标记视口活动（交互/场景变化/系统活动）：空闲降帧立即回到全速渲染 */
  markActivity(): void {
    this.lastActivityAt = performance.now();
  }

  /** 注入场景活动谓词（返回 true = 有活动内容，视口保持全速；如动画播放中） */
  addActivityHook(hook: () => boolean): void {
    this.activityHooks.push(hook);
  }

  /** 视口是否有活动（最近 IDLE 窗口内有交互，或任一活动谓词为真） */
  viewportActive(): boolean {
    if (performance.now() - this.lastActivityAt <= IDLE_DELAY_MS) return true;
    return this.activityHooks.some((h) => h());
  }

  /** 注入着色器编译失败回调（引擎接 "shader:error" 事件 → 编辑器控制台） */
  setShaderErrorCb(cb: ((message: string) => void) | null): void {
    this.shaderErrorCb = cb;
  }

  /** 注入清除状态提供方（每帧渲染前按活动相机调用；null 配置 = 保持默认全清与全局背景） */
  setClearProvider(provider: ((cam: THREE.Camera) => CameraClearState | null) | null): void {
    this.clearProvider = provider;
  }

  /** 注入画中画提供方（每帧主渲染完成后调用；null 配置 = 无画中画） */
  setPiPProvider(provider: ((viewW: number, viewH: number) => PiPRequest | null) | null): void {
    this.pipProvider = provider;
  }

  /** 注入 UI 布局视图独占渲染钩子（UISystem；场景视图/无画布时 begin 返回 0 零开销） */
  setUiSoloCb(cb: { begin(): number; end(): void } | null): void {
    this.uiSoloCb = cb;
  }

  /**
   * 渲染前按活动相机解析清除描述（渲染管线应用：改写 scene.background 与
   * 自动清屏标志）。background 由 provider 每帧给定（纯色/天空/无背景），
   * 与引擎的全局天空维护（applySkyFromGraph）不冲突：每帧重写，引擎侧仍是
   * 纹理的属主。
   */
  private clearDescFor(cam: THREE.Camera): RPIClearDesc {
    const state = this.clearProvider ? this.clearProvider(cam) : null;
    if (!state) {
      // 缺省全清 + 不动场景背景（全局背景保持）
      return { color: true, depth: true };
    }
    return { color: state.clearColor, depth: state.clearDepth, background: state.background };
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

  /** ResizeObserver 回调：只记录目标尺寸，不在布局阶段触碰 WebGL 缓冲。
   *  容器不可见（display:none 时 clientWidth/Height 为 0）不产生目标尺寸：
   *  若缩到 1×1，恢复显示的首帧会把 1 像素缓冲拉伸铺满视口（闪色块）——
   *  保持上一个有效尺寸渲染 1-2 帧，等容器拿到真实尺寸再正常缩放。 */
  private scheduleResize = (): void => {
    if (!this.container) return;
    const cw = this.container.clientWidth;
    const ch = this.container.clientHeight;
    if (cw <= 0 || ch <= 0) return;
    this.targetW = Math.max(1, cw);
    this.targetH = Math.max(1, ch);
  };

  /** 渲染循环内应用尺寸：改缓冲 + 更新所有相机宽高比后同帧立即渲染，避免黑闪 */
  private applySizeIfNeeded = (): void => {
    if (this.targetW === this.appliedW && this.targetH === this.appliedH) return;
    this.appliedW = this.targetW;
    this.appliedH = this.targetH;
    if (!this.device || this.appliedW < 1 || this.appliedH < 1) return;
    this.device.setSize(this.appliedW, this.appliedH, false);
    const aspect = this.appliedW / this.appliedH;
    this.cameras.forEach((c) => this.applyCameraAspect(c, aspect));
  };

  private loop = (): void => {
    if (this.paused) return;
    this.raf = requestAnimationFrame(this.loop);
    // 活动内容钩子（动画/粒子/物理/导航/逻辑/着色器时间）：既驱动空闲降帧判定，
    // 也驱动阴影图按需重画（见下方 shadowMap 门控）
    const contentActive = this.activityHooks.some((h) => h());
    const now = performance.now();
    // 空闲降帧（功耗）：无交互且无活动内容（活动钩子，见 viewportActive）时视口
    // 降频渲染——编辑器空闲时 GPU/CPU 从满速 rAF 降到 12fps，交互即刻恢复全速
    if (now - this.lastActivityAt > IDLE_DELAY_MS && !contentActive) {
      if (now - this.lastIdleRenderAt < 1000 / IDLE_FPS) return;
      this.lastIdleRenderAt = now;
    } else if (!this.activeLimiter.tick(now)) {
      // 活动期帧率上限（功耗）：高刷屏 Bresenham 数帧锁 60，60Hz 屏全渲零回归
      return;
    }
    this.applySizeIfNeeded();
    this.orbit?.update();
    this.renderCb?.();
    // 静态场景阴影图按需重画（WebGL）：阴影不依赖观察相机，轨道移动无需重画；
    // 只有场景内容变化（脏标记：图变更/几何重建）或活动内容（动画/粒子/物理）
    // 才重画，静态大场景免去每帧整套阴影 pass（DrawCall 约减半）
    if (this.device) {
      this.device.setShadowMapOnDemand(this.shadowDirtyRequested || contentActive);
      this.shadowDirtyRequested = false;
    }
    if (this.device) this.renderActive();
    this.tickStats();
  };

  /** 阴影脏标记（场景内容变化时由引擎标脏；下一帧重画一次阴影图） */
  markShadowDirty(): void {
    this.shadowDirtyRequested = true;
  }
  private shadowDirtyRequested = true;

  /** 每帧统计：FPS（EMA 平滑）。网格/顶点遍历统计只在 getStats 被拉取时按需做 */
  private tickStats(): void {
    const now = performance.now();
    if (this.statsLastTime > 0) {
      const dt = now - this.statsLastTime;
      if (dt > 0) {
        const instant = 1000 / dt;
        this.statsFps = this.statsFps > 0 ? this.statsFps * 0.9 + instant * 0.1 : instant;
      }
    }
    this.statsLastTime = now;
  }

  /** 获取渲染统计快照（调试面板用；网格/顶点数按需遍历并缓存 500ms） */
  getStats(): RenderStats {
    const info = this.device?.getStats();
    const now = performance.now();
    if (now - this.statsTraverseAt > 500) {
      this.statsTraverseAt = now;
      // 场景遍历统计（兼容 WebGPU：不依赖 renderer.info）
      let meshes = 0;
      let vertices = 0;
      this.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && mesh.geometry) {
          const pos = mesh.geometry.getAttribute("position");
          if (pos) {
            meshes++;
            vertices += pos.count;
          }
        }
      });
      this.statsMeshes = meshes;
      this.statsVertices = vertices;
    }
    return {
      fps: Math.round(this.statsFps),
      drawCalls: info?.drawCalls ?? 0,
      triangles: info?.triangles ?? 0,
      lines: info?.lines ?? 0,
      points: info?.points ?? 0,
      geometries: info?.geometries ?? 0,
      textures: info?.textures ?? 0,
      programs: info?.programs ?? 0,
      meshes: this.statsMeshes,
      vertices: this.statsVertices,
    };
  }

  /**
   * 渲染当前活动相机（含分层多 pass，经 RPI 管线）：
   * 相机掩码全开或在用层 ≤1 时单 pass（与旧渲染路径一致，零额外开销）；
   * 相机节点收窄了 Culling Mask 且场景占用多个掩码内层时按层拆 pass ——
   * 每个 pass 只渲染该层对象，灯光收集（light.layers vs 相机层）使
   * 每盏灯只照亮其掩码内的层（灯光 Culling Mask 语义），详见 RPI layerSet。
   */
  private renderActive(): void {
    const cam = this.activeCamera ?? this.camera;
    // 布局视图（UI 独占）：隐藏画布祖先链与 gizmo 之外的顶层子树后再渲染，
    // 布局视口只显示 Canvas 下的节点；灯光随场景子树隐藏 → 分层多 pass 自然
    // 退化为单 pass。场景视图 begin 返回 0，行为与旧渲染路径完全一致。
    const solo = this.uiSoloCb ? this.uiSoloCb.begin() : 0;
    this.pipeline.renderView({ scene: this.scene, camera: cam, clear: this.clearDescFor(cam) });
    if (this.uiSoloCb && solo > 0) this.uiSoloCb.end();
    // 画中画（相机节点选中）：主渲染完成后离屏渲小视图并回贴右下角矩形
    this.renderPiP();
  }

  /**
   * 画中画 pass：提供方给出画中画相机与矩形（null = 本帧无）。
   * 经 RPI 管线先整幅渲到离屏 RT（整附件清屏对主视图无副作用，WebGPU 语义
   * 安全），再以全屏三角形把 RT 纹理 scissor 裁剪回贴主画布矩形（绘制不清屏，
   * 两种后端一致）；离屏渲染期间清除状态由画中画相机的清除状态接管，结束
   * 复原（背景是引擎全局属主，主渲染每帧重写）。
   */
  private renderPiP(): void {
    const req = this.pipProvider?.(this.appliedW, this.appliedH) ?? null;
    if (!req || !this.device || this.appliedW < 1 || this.appliedH < 1) return;
    const dpr = this.device.getPixelRatio();
    const prevBg = this.scene.background;
    const target = this.pipeline.acquireTarget(req.rect.width * dpr, req.rect.height * dpr);
    try {
      req.begin();
      this.pipeline.renderToTarget(target, {
        scene: this.scene,
        camera: req.camera,
        clear: this.clearDescFor(req.camera),
      });
    } finally {
      req.end();
      this.scene.background = prevBg;
    }
    const x = this.appliedW - req.rect.right - req.rect.width;
    const y = req.rect.bottom;
    this.pipeline.blitTarget(
      target,
      { x, y, width: req.rect.width, height: req.rect.height },
      this.appliedW,
      this.appliedH,
    );
  }

  get domElement(): HTMLElement {
    return this.device.domElement;
  }

  /** 原始 WebGL 渲染器（仅 webgl 后端；离屏渲染等特殊用途；其他后端返回 null） */
  get glRenderer(): THREE.WebGLRenderer | null {
    if (!this.device || this.activeBackend !== "webgl") return null;
    return this.device.native as THREE.WebGLRenderer;
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
