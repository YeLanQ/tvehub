// ---------------------------------------------------------------------------
// 手动测试模型生成（Node 运行；vite --ssr 打包，与冒烟脚本同模式）：
// 生成高面数 UV 球的未压缩基线 GLB，供导入编辑器后体验
// 「右键 → Draco 压缩」与压缩模型加载。输出到 .tmp-models/（不入库）。
// 运行：npm run gen:test-model
// ---------------------------------------------------------------------------
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { buildTestSphereModel } from "./test-model";

async function main(): Promise<void> {
  const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", ".tmp-models");
  mkdirSync(outDir, { recursive: true });

  const { doc, vertexCount, triangleCount } = buildTestSphereModel();
  const io = new NodeIO();
  const glb = await io.writeBinary(doc);
  const out = join(outDir, "test-model.glb");
  writeFileSync(out, glb);

  console.log(
    `已生成: ${out}（顶点 ${vertexCount} / 三角形 ${triangleCount} / ${(glb.byteLength / 1024).toFixed(1)} KB）`,
  );
  console.log("在编辑器项目中导入该 GLB 后，右键 → 「Draco 压缩…」体验压缩链路。");
}

main().catch((e) => {
  console.error("生成失败:", e);
  process.exit(1);
});
