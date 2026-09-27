import { describe, expect, it } from "vitest";
import {
  SKY_ONLY_FIRST_PASS,
  UI_ONLY_FIRST_PASS,
  bitsOf,
  computeLayerPassBits,
  populatedLayerBits,
  renderLayerSet,
  type LayerCameraLike,
  type LayerNodeLike,
  type LayerSceneLike,
} from "./layerSet";

/** 桩节点（可渲染体/灯/标记物） */
function node(flags: Partial<LayerNodeLike> & { mask?: number }): LayerNodeLike {
  return {
    visible: true,
    layers: { mask: flags.mask ?? 1 },
    userData: {},
    isMesh: false,
    isLight: false,
    ...flags,
  };
}

/** 桩场景：扁平对象表 + traverseVisible 按 visible 过滤（近似三叶子树语义） */
function sceneOf(objects: LayerNodeLike[], background: unknown = null): LayerSceneLike {
  return {
    background,
    traverse: (cb) => objects.forEach(cb),
    traverseVisible: (cb) => objects.filter((o) => o.visible).forEach(cb),
  };
}

function cameraOf(mask: number): LayerCameraLike {
  return { layers: { mask } };
}

/** 记录型设备桩：按序记录 render/setAutoClear 调用 */
function recordingDevice() {
  const calls: string[] = [];
  return {
    calls,
    render(_scene: object, _camera: object): void {
      calls.push("render");
    },
    setAutoClear(color: boolean, depth: boolean): void {
      calls.push(`clear:${color},${depth}`);
    },
  };
}

describe("computeLayerPassBits", () => {
  it("相机掩码全开且无灯光 → 单 pass（null，零开销默认路径）", () => {
    const scene = sceneOf([node({ isMesh: true, mask: 0b11 })]);
    expect(computeLayerPassBits(scene, cameraOf(-1))).toBeNull();
  });

  it("掩码全开 + 部分掩码灯光 + 多层占用 → 按层拆（灯光 Culling Mask 恒生效）", () => {
    const scene = sceneOf([
      node({ isMesh: true, mask: 0b01 }),
      node({ isMesh: true, mask: 0b10 }),
      node({ isLight: true, mask: 0b01 }),
    ]);
    expect(computeLayerPassBits(scene, cameraOf(-1))).toEqual([0b01, 0b10]);
  });

  it("掩码全开 + 全开灯光 → 单 pass（灯光无部分掩码）", () => {
    const scene = sceneOf([
      node({ isMesh: true, mask: 0b11 }),
      node({ isLight: true, mask: -1 }),
    ]);
    expect(computeLayerPassBits(scene, cameraOf(-1))).toBeNull();
  });

  it("相机收窄掩码且掩码内多层占用 → 拆掩码内的层", () => {
    const scene = sceneOf([
      node({ isMesh: true, mask: 0b011 }),
      node({ isMesh: true, mask: 0b100 }),
    ]);
    expect(computeLayerPassBits(scene, cameraOf(0b011))).toEqual([0b001, 0b010]);
  });

  it("掩码内仅一个在用层 → 单 pass", () => {
    const scene = sceneOf([node({ isMesh: true, mask: 0b011 })]);
    expect(computeLayerPassBits(scene, cameraOf(0b010))).toBeNull();
  });

  it("空场景 / 掩码内无在用层 → null", () => {
    expect(computeLayerPassBits(sceneOf([]), cameraOf(-1))).toBeNull();
    expect(computeLayerPassBits(sceneOf([node({ isMesh: true, mask: 0b100 })]), cameraOf(0b001))).toBeNull();
  });

  it("不可见对象不参与层占用统计", () => {
    const scene = sceneOf([node({ isMesh: true, mask: 0b10, visible: false })]);
    expect(populatedLayerBits(scene)).toBe(0);
    expect(computeLayerPassBits(scene, cameraOf(0b10))).toBeNull();
  });
});

describe("bitsOf", () => {
  it("掩码 → 升序单层位列表", () => {
    expect(bitsOf(0b101)).toEqual([0b001, 0b100]);
    expect(bitsOf(0)).toEqual([]);
  });
});

describe("renderLayerSet", () => {
  it("逐层渲染：首个 pass 用调用方就位状态，后续 pass 不清屏不画背景", () => {
    const scene = sceneOf([node({ isMesh: true, mask: 0b11 })], "bg");
    const cam = cameraOf(0b11);
    const dev = recordingDevice();
    renderLayerSet(dev, scene, cam, [0b01, 0b10], { color: true, depth: true });
    expect(dev.calls).toEqual(["render", "clear:false,false", "render", "clear:true,true"]);
    expect(scene.background).toBe("bg");
    expect(cam.layers.mask).toBe(0b11);
  });

  it("skyOnly/uiOnly 标记物在后续 pass 隐藏、结束后恢复可见", () => {
    const sky = node({ isMesh: true, mask: 1 });
    sky.userData![SKY_ONLY_FIRST_PASS] = true;
    const ui = node({ isMesh: true, mask: 1 });
    ui.userData![UI_ONLY_FIRST_PASS] = true;
    const scene = sceneOf([sky, ui]);
    const dev = recordingDevice();
    renderLayerSet(dev, scene, cameraOf(0b11), [0b01, 0b10], { color: true, depth: true });
    expect(sky.visible).toBe(true);
    expect(ui.visible).toBe(true);
  });

  it("结束时恢复 baseClear 清屏标志（主 pass 状态）", () => {
    const scene = sceneOf([node({ isMesh: true, mask: 0b11 })]);
    const dev = recordingDevice();
    renderLayerSet(dev, scene, cameraOf(0b11), [0b01, 0b10], { color: false, depth: true });
    expect(dev.calls[dev.calls.length - 1]).toBe("clear:false,true");
  });

  it("渲染中抛错也恢复相机掩码/背景/可见性（finally 语义）", () => {
    const mesh = node({ isMesh: true, mask: 0b11 });
    const scene = sceneOf([mesh], "bg");
    const cam = cameraOf(0b11);
    const dev = {
      render(): void {
        throw new Error("boom");
      },
      setAutoClear(): void {},
    };
    expect(() => renderLayerSet(dev, scene, cam, [0b01, 0b10], { color: true, depth: true })).toThrow(
      "boom",
    );
    expect(cam.layers.mask).toBe(0b11);
    expect(scene.background).toBe("bg");
    expect(mesh.visible).toBe(true);
  });
});
