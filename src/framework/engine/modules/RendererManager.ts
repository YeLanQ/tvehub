import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/**
 * 渲染器管理：编辑器视口渲染。
 *
 * 渲染设计要点：
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
  renderer!: THREE.WebGLRenderer;
  private orbit!: OrbitControls;
  private container!: HTMLElement;
  private raf = 0;
  private resizeObs?: ResizeObserver;
  private renderCb?: () => void;

  /** 所有需要随视口比例更新的相机（编辑器相机 + 预览相机等） */
  private cameras = new Set<THREE.PerspectiveCamera>();
  /** 当前渲染使用的相机（默认编辑器相机） */
  private activeCamera: THREE.PerspectiveCamera | null = null;

  /** 容器期望尺寸（ResizeObserver 记录，渲染循环里再应用） */
  private targetW = 0;
  private targetH = 0;
  /** 已应用到画布的尺寸 */
  private appliedW = 0;
  private appliedH = 0;

  mount(container: HTMLElement): void {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
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

    this.scene.background = new THREE.Color(0x141414);
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

  /** 注册需要跟随视口宽高比更新的相机 */
  registerCamera(cam: THREE.PerspectiveCamera): void {
    this.cameras.add(cam);
    if (this.appliedW > 0 && this.appliedH > 0) {
      cam.aspect = this.appliedW / this.appliedH;
      cam.updateProjectionMatrix();
    }
  }

  /** 切换当前渲染相机（编辑器相机 与 预览相机 之间切换） */
  setActiveCamera(cam: THREE.PerspectiveCamera): void {
    this.activeCamera = cam;
  }

  getActiveCamera(): THREE.PerspectiveCamera | null {
    return this.activeCamera;
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
    this.cameras.forEach((c) => {
      c.aspect = aspect;
      c.updateProjectionMatrix();
    });
  };

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    this.applySizeIfNeeded();
    this.orbit?.update();
    this.renderCb?.();
    if (this.renderer) this.renderer.render(this.scene, this.activeCamera ?? this.camera);
  };

  get domElement(): HTMLElement {
    return this.renderer.domElement;
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
