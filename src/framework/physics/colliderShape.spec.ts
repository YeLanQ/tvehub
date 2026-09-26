import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { computeColliderShapeDesc, downsampleHeightfield, terrainMeshSigOf } from "./colliderShape";
import { DEFAULT_COLLIDER_SETTINGS } from "./types";

// 高度场碰撞贴合：地形内容签名读取（生产布局 = 组上写签名）与高度下采样。

/** 生产布局伪地形：节点对象 → __terrainMesh 组（签名/统计在组上）→ chunk mesh（高度缓存在 mesh 上） */
function makeTerrainTree(sig: string, heights: Float32Array, gridN: number, size: number): THREE.Object3D {
  const node = new THREE.Object3D();
  const group = new THREE.Group();
  group.name = "__terrainMesh";
  group.userData.terrainSig = sig;
  const chunk = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  chunk.userData.terrainHeights = heights;
  chunk.userData.terrainGridSize = gridN;
  chunk.userData.terrainSize = size;
  group.add(chunk);
  node.add(group);
  node.updateMatrixWorld(true);
  return node;
}

const flat = (n: number, v: number) => new Float32Array(n * n).fill(v);

describe("terrainMeshSigOf", () => {
  it("生产布局：签名写在地形组上也能读到（模拟中地形变化触发碰撞重建的链路）", () => {
    const obj = makeTerrainTree("sig-a", flat(4, 1), 4, 10);
    expect(terrainMeshSigOf(obj)).toBe("sig-a");
  });

  it("旧布局：签名直接写在 chunk mesh 上仍生效", () => {
    const node = new THREE.Object3D();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.userData.terrainSig = "sig-mesh";
    node.add(mesh);
    expect(terrainMeshSigOf(node)).toBe("sig-mesh");
  });

  it("空值/异常：无地形子树、非字符串签名 → 空串", () => {
    expect(terrainMeshSigOf(new THREE.Object3D())).toBe("");
    expect(terrainMeshSigOf(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)))).toBe("");
    const bogus = new THREE.Object3D();
    bogus.userData.terrainSig = 123;
    expect(terrainMeshSigOf(bogus)).toBe("");
  });
});

describe("downsampleHeightfield", () => {
  it("正常：3×3 → 5×5 角点保持源值（最近邻取真实烘焙点）", () => {
    const src = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const ds = downsampleHeightfield(src, 3, 5, 1);
    expect(ds).toHaveLength(25);
    expect(ds[0]).toBe(0);
    expect(ds[4]).toBe(2);
    expect(ds[20]).toBe(6);
    expect(ds[24]).toBe(8);
  });

  it("边界：257 → 256 端点精确落位（默认地形网格满分辨率采样）", () => {
    const n = 257;
    const src = new Float32Array(n * n);
    src[0] = 3;
    src[n * n - 1] = 7;
    const ds = downsampleHeightfield(src, n, 256, 1);
    expect(ds[0]).toBe(3);
    expect(ds[255 * 256 + 255]).toBe(7);
  });

  it("scaleY 烘焙进输出高度", () => {
    const ds = downsampleHeightfield(Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]), 3, 3, 2);
    expect(ds[8]).toBe(16);
  });
});

describe("computeColliderShapeDesc(heightfield)", () => {
  it("正常：从 chunk mesh 高度缓存推导采样/边长/min/max（签名在组上、缓存在 mesh 上）", () => {
    const obj = makeTerrainTree("s", flat(8, 2), 8, 20);
    const desc = computeColliderShapeDesc(
      { ...DEFAULT_COLLIDER_SETTINGS, shape: "heightfield", resolution: 64 },
      obj,
    );
    expect(desc.samples).toBe(64);
    expect(desc.terrainSizeX).toBe(20);
    expect(desc.terrainSizeZ).toBe(20);
    expect(desc.minHeight).toBe(2);
    expect(desc.maxHeight).toBe(2);
  });

  it("自动档：resolution 0（新默认）→ 采样密度对齐地形网格（8 网格 → 64 档）", () => {
    const obj = makeTerrainTree("s", flat(8, 2), 8, 20);
    const desc = computeColliderShapeDesc({ ...DEFAULT_COLLIDER_SETTINGS, shape: "heightfield" }, obj);
    expect(desc.samples).toBe(64); // resolveHeightfieldSamples(0, 8) → 最小可用档 64
    // 大网格：257（segments 256）→ 256 档，采样点恒落在烘焙顶点上
    const big = makeTerrainTree("s", flat(257, 1), 257, 2000);
    expect(computeColliderShapeDesc({ ...DEFAULT_COLLIDER_SETTINGS, shape: "heightfield" }, big).samples).toBe(256);
  });

  it("异常：非地形对象 → heights 为 null（回退盒形），不抛错", () => {
    const desc = computeColliderShapeDesc(
      { ...DEFAULT_COLLIDER_SETTINGS, shape: "heightfield" },
      new THREE.Object3D(),
    );
    expect(desc.heights).toBeNull();
    expect(desc.shape).toBe("heightfield");
  });
});
