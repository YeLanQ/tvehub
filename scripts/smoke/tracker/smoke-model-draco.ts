// ---------------------------------------------------------------------------
// Draco 压缩管线冒烟测试（Node 运行；vite --ssr 打包）：
// 复用 src/app/lib/model-draco 的 compressDocument 管线核心（与编辑器内完全一致，
// 仅 IO 换成 NodeIO），对高面数测试模型执行：
//   1. 压缩产物声明 KHR_draco_mesh_compression 且体积显著小于基线；
//   2. 量化位宽按档位生效（高精度 > 标准体积）；
//   3. 压缩后 Document 可往返读取，顶点/三角形/属性数量完整；
//   4. 已压缩模型重复执行安全（primitive 跳过，不叠加压缩）。
// 运行：pnpm smoke model-draco
// ---------------------------------------------------------------------------
import assert from "node:assert";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { createDecoderModule, createEncoderModule } from "draco3dgltf";
import { buildTestSphereModel } from "../../test-model";
import {
  compressDocument,
  type DracoCompressOptions,
} from "../../../src/app/lib/model-draco";
import { createSuite } from "../harness.mjs";

const { ok, finish } = createSuite();

/** Accessor 包围盒（几何完整性校验用） */
function accBounds(acc: { getCount(): number; getElement(i: number, out: number[]): number[] }): {
  min: number[];
  max: number[];
} {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const tmp: number[] = [];
  for (let i = 0; i < acc.getCount(); i++) {
    acc.getElement(i, tmp);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], tmp[k]);
      max[k] = Math.max(max[k], tmp[k]);
    }
  }
  return { min, max };
}

/** 与编辑器一致的 IO 装配（draco3d 为 node 侧模块：自带 fs wasm 定位） */
async function createNodeModelIO(): Promise<NodeIO> {
  const io = new NodeIO();
  io.registerExtensions(ALL_EXTENSIONS);
  io.registerDependencies({
    "draco3d.encoder": await createEncoderModule(),
    "draco3d.decoder": await createDecoderModule(),
  });
  return io;
}

async function main(): Promise<void> {
  console.log("[smoke:model-draco] 构建 13 万顶点测试球 …");
  const { doc, vertexCount, triangleCount } = buildTestSphereModel();
  const io = await createNodeModelIO();
  const baseline = await io.writeBinary(doc);
  console.log(`  基线 GLB: ${(baseline.byteLength / 1024).toFixed(1)} KB`);
  ok(vertexCount > 50_000, `测试模型规模足够（顶点 ${vertexCount} / 三角形 ${triangleCount}）`);

  const run = async (opts: DracoCompressOptions) =>
    compressDocument(await io.readBinary(baseline), opts, io);

  // 1. 标准档：声明 Draco 扩展 + 显著减小
  const std = await run({ speed: 5, quality: "standard" });
  const stdDoc = await io.readBinary(std);
  const extensionsUsed = stdDoc.getRoot().listExtensionsUsed().map((e) => e.extensionName);
  console.log(`  标准档: ${(std.byteLength / 1024).toFixed(1)} KB（扩展 ${extensionsUsed.join(", ")}）`);
  ok(
    extensionsUsed.includes("KHR_draco_mesh_compression"),
    "产物声明 KHR_draco_mesh_compression",
  );
  ok(std.byteLength < baseline.byteLength * 0.5, "标准档体积 < 基线 50%");

  // 2. 往返完整：Draco 编码会合并重复顶点、剔除退化三角形（球体两极），
  //    顶点/索引按容差校验（偏差 <1% 视为完整），属性集合必须全保留
  const prim = stdDoc.getRoot().listMeshes()[0]?.listPrimitives()[0];
  ok(prim != null, "压缩产物含网格 primitive");
  if (prim) {
    const posCount = prim.getAttribute("POSITION")?.getCount() ?? 0;
    const idxCount = prim.getIndices()?.getCount() ?? 0;
    ok(
      posCount <= vertexCount && posCount >= vertexCount * 0.99,
      `POSITION 数量完整（${posCount}/${vertexCount}，Draco 量化合并重复顶点）`,
    );
    ok(
      idxCount % 3 === 0 && idxCount >= triangleCount * 3 * 0.99,
      `索引数量完整（${idxCount}/${triangleCount * 3}，退化三角形被剔除）`,
    );
    ok(prim.getAttribute("NORMAL") != null, "NORMAL 属性保留");
    ok(prim.getAttribute("TEXCOORD_0") != null, "TEXCOORD_0 属性保留");
    // 几何完整性语义校验：包围盒与基线一致（平移/缩放不失真）
    const baseAcc = (await io.readBinary(baseline)).getRoot().listMeshes()[0]?.listPrimitives()[0]?.getAttribute("POSITION");
    if (baseAcc) {
      const b1 = accBounds(baseAcc);
      const b2 = accBounds(prim.getAttribute("POSITION")!);
      const close = (a: number[], b: number[]) =>
        a.every((v, i) => Math.abs(v - b[i]) < 0.01);
      ok(close(b1.min, b2.min) && close(b1.max, b2.max), "包围盒与基线一致（几何无失真）");
    }
  }

  // 3. 高精度档：量化位宽更高 → 体积大于标准档（仍小于基线）
  const high = await run({ speed: 5, quality: "high" });
  console.log(
    `  高精度档: ${(high.byteLength / 1024).toFixed(1)} KB`,
  );
  ok(high.byteLength > std.byteLength, "高精度档体积 > 标准档");
  ok(high.byteLength < baseline.byteLength * 0.75, "高精度档体积 < 基线 75%");

  // 4. 速度档影响：最快档体积 ≥ 中速档（不严格单调但同模型通常成立）
  const fast = await run({ speed: 10, quality: "standard" });
  ok(fast.byteLength >= std.byteLength, "速度 10 体积 ≥ 速度 5");

  // 5. 重复压缩安全：已压缩模型再跑一次，primitive 不叠加（仍只有一个 Draco 扩展）
  const twice = await compressDocument(stdDoc, { speed: 5, quality: "standard" }, io);
  const twiceExt = (await io.readBinary(twice))
    .getRoot()
    .listExtensionsUsed()
    .map((e) => e.extensionName)
    .filter((n) => n === "KHR_draco_mesh_compression");
  ok(twiceExt.length === 1, "重复压缩不叠加（KHR_draco_mesh_compression 仅 1 处）");

  finish();
}

main().catch((e) => {
  console.error("[smoke:model-draco] 异常:", e);
  process.exit(1);
});
