import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { RHIRect, RHIRenderTarget, RHIRenderTargetDesc } from "../../../rhi";
import { createThreePipeline } from "./pipeline";
import type { LayerSceneLike } from "../../layerSet";

/** 记录型设备桩：无 GPU 依赖地验证管线组织的调用序列 */
function recordingDevice() {
  const log: string[] = [];
  let rtSeq = 0;
  const targets: FakeTarget[] = [];
  class FakeTarget implements RHIRenderTarget {
    desc: RHIRenderTargetDesc;
    readonly handle: unknown;
    constructor(desc: RHIRenderTargetDesc) {
      this.desc = { ...desc };
      this.handle = { id: ++rtSeq };
      targets.push(this);
    }
    get texture(): unknown {
      return { fake: this.handle };
    }
    resize(w: number, h: number): void {
      this.desc.width = w;
      this.desc.height = h;
    }
    dispose(): void {}
  }
  const device = {
    log,
    targets,
    kind: "webgl" as const,
    domElement: document.createElement("canvas"),
    native: {},
    configureDisplay(): void {},
    setPixelRatio(): void {},
    getPixelRatio: () => 2,
    setSize(): void {},
    render(scene: object, camera: object): void {
      const s = scene as { __id?: string };
      const c = camera as { __id?: string };
      log.push(`render:${s.__id ?? "anon"}/${c.__id ?? "cam"}`);
    },
    warmupShaders(): unknown {
      return undefined;
    },
    setAutoClear(color: boolean, depth: boolean): void {
      log.push(`clear:${color},${depth}`);
    },
    setShadowMapEnabled(): void {},
    setShadowMapOnDemand(): void {},
    createRenderTarget(desc: RHIRenderTargetDesc): RHIRenderTarget {
      log.push(`rt:${desc.width}x${desc.height}`);
      return new FakeTarget(desc);
    },
    setRenderTarget(t: RHIRenderTarget | null): void {
      log.push(`bind:${t ? "rt" : "screen"}`);
    },
    setViewport(rect: RHIRect): void {
      log.push(`viewport:${rect.x},${rect.y},${rect.width},${rect.height}`);
    },
    setScissor(rect: RHIRect): void {
      log.push(`scissor:${rect.x},${rect.y},${rect.width},${rect.height}`);
    },
    setScissorTest(test: boolean): void {
      log.push(`scissorTest:${test}`);
    },
    getStats: () => ({
      drawCalls: 0,
      triangles: 0,
      lines: 0,
      points: 0,
      geometries: 0,
      textures: 0,
      programs: 0,
    }),
    dispose(): void {},
  };
  return device;
}

/** 桩场景：单层一个可渲染体（单 pass 路径） */
function plainScene(): { scene: object & LayerSceneLike; camera: object } {
  const scene = {
    __id: "main",
    background: null,
    traverse: (cb: (o: never) => void) =>
      cb({ visible: true, layers: { mask: 1 }, userData: {}, isMesh: true } as never),
    traverseVisible: (cb: (o: never) => void) =>
      cb({ visible: true, layers: { mask: 1 }, userData: {}, isMesh: true } as never),
  };
  const camera = { __id: "cam", layers: { mask: -1 } };
  return { scene: scene as never, camera };
}

describe("RPI three 管线", () => {
  it("renderView 单 pass：应用清除状态后直接渲染", () => {
    const dev = recordingDevice();
    const pipeline = createThreePipeline(dev as never);
    const { scene, camera } = plainScene();
    (scene as { background: unknown }).background = "old";
    pipeline.renderView({ scene, camera, clear: { color: true, depth: true, background: "sky" } });
    expect(dev.log).toEqual(["clear:true,true", "render:main/cam"]);
    expect((scene as { background: unknown }).background).toBe("sky");
  });

  it("renderView 无 clear 描述：默认全清且不动场景背景", () => {
    const dev = recordingDevice();
    const pipeline = createThreePipeline(dev as never);
    const { scene, camera } = plainScene();
    (scene as { background: unknown }).background = "keep";
    pipeline.renderView({ scene, camera });
    expect(dev.log).toEqual(["clear:true,true", "render:main/cam"]);
    expect((scene as { background: unknown }).background).toBe("keep");
  });

  it("clear.background 为 null：显式无背景（保留上一帧画面的清除语义）", () => {
    const dev = recordingDevice();
    const pipeline = createThreePipeline(dev as never);
    const { scene, camera } = plainScene();
    pipeline.renderView({ scene, camera, clear: { color: false, depth: true, background: null } });
    expect(dev.log[0]).toBe("clear:false,true");
    expect((scene as { background: unknown }).background).toBeNull();
  });

  it("renderOverlay：不清屏不画背景，结束后恢复场景背景", () => {
    const dev = recordingDevice();
    const pipeline = createThreePipeline(dev as never);
    const { scene, camera } = plainScene();
    (scene as { background: unknown }).background = "prev";
    pipeline.renderOverlay({ scene, camera });
    expect(dev.log).toEqual(["clear:false,false", "render:main/cam"]);
    expect((scene as { background: unknown }).background).toBe("prev");
  });

  it("acquireTarget：惰性创建 half-float+MSAA4 目标，尺寸变化时复用重建", () => {
    const dev = recordingDevice();
    const pipeline = createThreePipeline(dev as never);
    const t1 = pipeline.acquireTarget(280 * 2, 158 * 2);
    expect(dev.targets).toHaveLength(1);
    expect(t1.desc).toMatchObject({ width: 560, height: 316, format: "half-float", samples: 4 });
    const t2 = pipeline.acquireTarget(560, 316);
    expect(t2).toBe(t1);
    const t3 = pipeline.acquireTarget(512, 512);
    expect(t3).toBe(t1);
    expect(t1.desc).toMatchObject({ width: 512, height: 512 });
    expect(dev.log.filter((l) => l.startsWith("rt:"))).toEqual(["rt:560x316"]);
  });

  it("renderToTarget：绑定目标渲染后回绑主画布（异常也回绑）", () => {
    const dev = recordingDevice();
    const pipeline = createThreePipeline(dev as never);
    const target = pipeline.acquireTarget(64, 64);
    const { scene, camera } = plainScene();
    pipeline.renderToTarget(target, { scene, camera });
    expect(dev.log).toEqual([
      "rt:64x64",
      "bind:rt",
      "clear:true,true",
      "render:main/cam",
      "bind:screen",
    ]);
  });

  it("blitTarget：scissor 裁剪回贴（不清屏绘制）并恢复全屏视口", () => {
    const dev = recordingDevice();
    const pipeline = createThreePipeline(dev as never);
    const target = pipeline.acquireTarget(280, 158);
    pipeline.blitTarget(target, { x: 10, y: 12, width: 280, height: 158 }, 1600, 900);
    expect(dev.log).toEqual([
      "rt:280x158",
      "scissorTest:true",
      "scissor:10,12,280,158",
      "viewport:10,12,280,158",
      "clear:false,false",
      "render:anon/cam",
      "scissorTest:false",
      "viewport:0,0,1600,900",
    ]);
  });

  it("blitTarget 的回贴场景是 three 场景 + 全屏四边形（真实 three 对象）", () => {
    const dev = recordingDevice();
    const pipeline = createThreePipeline(dev as never);
    const target = pipeline.acquireTarget(64, 64);
    let captured: unknown;
    (dev as unknown as { render(s: unknown, c: unknown): void }).render = (s: unknown, c: unknown) => {
      captured = { s, c };
    };
    pipeline.blitTarget(target, { x: 0, y: 0, width: 10, height: 10 }, 100, 100);
    expect(captured).toBeDefined();
    const { s, c } = captured as { s: THREE.Scene; c: THREE.OrthographicCamera };
    expect(s).toBeInstanceOf(THREE.Scene);
    expect(c).toBeInstanceOf(THREE.OrthographicCamera);
    expect(s.children[0]).toBeInstanceOf(THREE.Mesh);
  });

  it("dispose：释放离屏目标与回贴资源", () => {
    const dev = recordingDevice();
    const pipeline = createThreePipeline(dev as never);
    pipeline.acquireTarget(64, 64);
    pipeline.dispose();
    // 再次 acquire 在 dispose 后会重建（目标已释放）
    const t = pipeline.acquireTarget(64, 64);
    expect(dev.targets.length).toBeGreaterThanOrEqual(2);
    expect(t.desc.width).toBe(64);
  });
});
