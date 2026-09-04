import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export class RendererManager {
  readonly scene = new THREE.Scene();
  camera!: THREE.PerspectiveCamera;
  renderer!: THREE.WebGLRenderer;
  private orbit!: OrbitControls;
  private container!: HTMLElement;
  private raf = 0;
  private resizeObs?: ResizeObserver;
  private renderCb?: () => void;

  mount(container: HTMLElement): void {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.position = "absolute";
    this.renderer.domElement.style.top = "0";
    this.renderer.domElement.style.left = "0";
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x141414);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
    this.camera.position.set(6, 6, 9);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;

    const dom = this.renderer.domElement;
    dom.addEventListener("contextmenu", (e) => e.preventDefault(), { passive: false });
    dom.addEventListener("gesturestart", (e) => e.preventDefault(), { passive: false });
    dom.addEventListener("gesturechange", (e) => e.preventDefault(), { passive: false });
    dom.addEventListener("gestureend", (e) => e.preventDefault(), { passive: false });

    const grid = new THREE.GridHelper(40, 40, 0x3f3f3f, 0x262626);
    grid.name = "__grid";
    this.scene.add(grid);

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
    this.loop();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObs?.disconnect();
    if (this.renderer) {
      this.renderer.domElement.parentElement?.removeChild(this.renderer.domElement);
      this.renderer.dispose();
    }
  }

  setRenderCb(cb: () => void): void {
    this.renderCb = cb;
  }

  private resize = (): void => {
    if (!this.renderer) return;
    const w = this.container.clientWidth || 512;
    const h = this.container.clientHeight || 512;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    this.orbit?.update();
    this.renderCb?.();
    if (this.renderer) this.renderer.render(this.scene, this.camera);
  };

  get domElement(): HTMLElement {
    return this.renderer.domElement;
  }

  get orbitControls(): OrbitControls {
    return this.orbit;
  }
}