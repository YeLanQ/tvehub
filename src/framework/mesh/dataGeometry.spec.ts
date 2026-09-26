import { describe, expect, it } from "vitest";
import {
  buildDataGeometry,
  importMeshDataFile,
  meshDataBounds,
  meshDataSig,
  parseMeshData,
} from "./dataGeometry";
import { MeshNode } from "../prototype/nodes/MeshNode";

// 数据化网格：JSON/XYZ 导入 → 载荷 → BufferGeometry → 节点持久化。

const jsonMesh = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], indices: [0, 1, 2, 1, 3, 2], ...over });

describe("importMeshDataFile", () => {
  it("正常：JSON 显式网格（含索引/法线/UV）", () => {
    const p = importMeshDataFile("quad.json", ".json", jsonMesh({ normals: new Array(12).fill(0), uvs: [0, 0, 1, 0, 0, 1, 1, 1] }));
    expect(p.format).toBe("json");
    expect(p.vertexCount).toBe(4);
    expect(p.indexCount).toBe(6);
    expect(p.sourceName).toBe("quad.json");
  });

  it("正常：JSON 无法线 → 留空由构建期计算", () => {
    const p = importMeshDataFile("q.json", ".json", jsonMesh());
    expect(p.normals).toBe("");
  });

  it("正常：XYZ 规则格点自动检测列数并三角化", () => {
    const pts: string[] = [];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) pts.push(`${c} 0 ${r}`);
    const p = importMeshDataFile("grid.xyz", ".xyz", pts.join("\n"));
    expect(p.vertexCount).toBe(20);
    expect(p.indexCount).toBe(3 * 2 * 3 * 4); // (cols-1)×(rows-1)×6 = 4×3×6
    expect(p.format).toBe("xyz");
  });

  it("异常：散点（x 不回绕）/缺 positions/索引越界/未知扩展 抛错", () => {
    expect(() => importMeshDataFile("s.xyz", ".xyz", "0 0 0\n1 0 0\n2 0 0")).toThrow();
    expect(() => importMeshDataFile("b.json", ".json", '{"indices":[0]}')).toThrow();
    expect(() => importMeshDataFile("b.json", ".json", jsonMesh({ indices: [0, 1, 99] }))).toThrow();
    expect(() => importMeshDataFile("x.stl", ".stl", "")).toThrow("不支持");
  });

  it("空值：空文本/无有效行 抛错不静默", () => {
    expect(() => importMeshDataFile("e.json", ".json", "")).toThrow();
    expect(() => importMeshDataFile("e.xyz", ".xyz", "a b c\nd e f")).toThrow();
  });
});

describe("buildDataGeometry / meshDataBounds", () => {
  it("正常：位置+索引构建；缺法线自动计算", () => {
    const p = importMeshDataFile("q.json", ".json", jsonMesh());
    const g = buildDataGeometry(p);
    expect(g.getAttribute("position").count).toBe(4);
    expect(g.getIndex()!.count).toBe(6);
    expect(g.getAttribute("normal")).toBeTruthy();
    g.dispose();
  });

  it("边界：非索引网格（indexCount=0）合法", () => {
    const p = parseMeshData(importMeshDataFile("q.json", ".json", jsonMesh({ indices: undefined })))!;
    expect(p.indexCount).toBe(0);
    const g = buildDataGeometry(p);
    expect(g.getIndex()).toBeNull();
    g.dispose();
  });

  it("异常：载荷损坏（positions 解不出/长度不符）构建抛错", () => {
    const p = parseMeshData(importMeshDataFile("q.json", ".json", jsonMesh()))!;
    expect(() => buildDataGeometry({ ...p, positions: "###" })).toThrow();
    expect(() => buildDataGeometry({ ...p, vertexCount: 9 })).toThrow();
  });

  it("bounds：四点平面 quad 包围盒", () => {
    const p = importMeshDataFile("q.json", ".json", jsonMesh());
    const b = meshDataBounds(p)!;
    expect(b.min).toEqual([0, 0, 0]);
    expect(b.max).toEqual([1, 1, 0]);
  });
});

describe("meshDataSig / MeshNode 持久化", () => {
  it("sig 区分载荷与空；MeshNode 序列化往返保持 source=data", () => {
    expect(meshDataSig(null)).toBe("nodata");
    const p = importMeshDataFile("q.json", ".json", jsonMesh());
    // 等长变异打在采样点（第 8 字符）与长度变异都要能检出
    const flip = p.positions.slice(0, 8) + (p.positions[8] === "A" ? "B" : "A") + p.positions.slice(9);
    expect(meshDataSig(p)).not.toBe(meshDataSig({ ...p, positions: flip }));
    expect(meshDataSig(p)).not.toBe(meshDataSig({ ...p, positions: p.positions.slice(0, -2) }));

    const n = new MeshNode();
    n.source = "data";
    n.dataMesh = p;
    const json = n.toJSON() as Record<string, unknown>;
    expect(json.source).toBe("data");
    expect((json.dataMesh as { vertexCount: number }).vertexCount).toBe(4);
    const restored = new MeshNode();
    restored.applyJSON(json);
    expect(restored.source).toBe("data");
    expect(restored.dataMesh?.indexCount).toBe(6);
  });

  it("空值：旧场景（无 dataMesh）dataMesh 为 null；source=data 在空/坏载荷下保持（幂等回填不降级）", () => {
    const n = new MeshNode();
    n.applyJSON({ source: "data", geometry: "box", dataMesh: { vertexCount: 1, positions: "" } });
    expect(n.source).toBe("data"); // 建而未导入是合法态（渲染基元占位）；回填快照同形不能洗掉
    expect(n.dataMesh).toBeNull();
    const plain = new MeshNode();
    expect("dataMesh" in (plain.toJSON() as Record<string, unknown>)).toBe(false);
  });
});
