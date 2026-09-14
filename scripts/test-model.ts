// ---------------------------------------------------------------------------
// Draco 压缩链路测试模型（冒烟测试与手动导入共用）：
// 程序化 UV 球（约 13 万顶点、26 万三角形），POSITION/NORMAL/TEXCOORD_0 + 索引，
// 纯数学生成，无 DOM / 文件依赖。输出为 gltf-transform Document（含单网格单节点）。
// ---------------------------------------------------------------------------

import { Document } from "@gltf-transform/core";

export interface TestModelBuild {
  doc: Document;
  vertexCount: number;
  triangleCount: number;
}

export function buildTestSphereModel(widthSegs = 384, heightSegs = 192): TestModelBuild {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let y = 0; y <= heightSegs; y++) {
    const v = y / heightSegs;
    const theta = v * Math.PI;
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    for (let x = 0; x <= widthSegs; x++) {
      const u = x / widthSegs;
      const phi = u * Math.PI * 2;
      const nx = -sinT * Math.cos(phi);
      const ny = cosT;
      const nz = sinT * Math.sin(phi);
      positions.push(nx, ny, nz);
      normals.push(nx, ny, nz);
      uvs.push(u, 1 - v);
    }
  }
  const stride = widthSegs + 1;
  for (let y = 0; y < heightSegs; y++) {
    for (let x = 0; x < widthSegs; x++) {
      const a = y * stride + x;
      const b = a + stride;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  const doc = new Document();
  doc.getRoot().setName("test-sphere");
  doc.createBuffer("testBuffer"); // GLB 写出要求文档含 Buffer 资源（顶点数据挂其下）
  const material = doc
    .createMaterial("sphereMat")
    .setBaseColorFactor([0.7, 0.5, 0.3, 1])
    .setMetallicFactor(0.1)
    .setRoughnessFactor(0.8);
  const prim = doc
    .createPrimitive()
    .setMaterial(material)
    .setAttribute(
      "POSITION",
      doc.createAccessor().setType("VEC3").setArray(new Float32Array(positions)),
    )
    .setAttribute(
      "NORMAL",
      doc.createAccessor().setType("VEC3").setArray(new Float32Array(normals)),
    )
    .setAttribute(
      "TEXCOORD_0",
      doc.createAccessor().setType("VEC2").setArray(new Float32Array(uvs)),
    )
    .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint32Array(indices)));
  const mesh = doc.createMesh("sphereMesh").addPrimitive(prim);
  const node = doc.createNode("sphere").setMesh(mesh);
  doc.createScene("test").addChild(node);
  return {
    doc,
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };
}
