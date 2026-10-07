// 微信 bundle · Draco 主线程内联解码冒烟（node 自包含，构建链内运行）：
// 用 draco3dgltf 编码器现场压缩一个最小网格 → 从 GLB 提取 KHR_draco_mesh_
// compression 的 bufferView 原始字节 → 经 DracoInlineLoader（桥接钩子
// __tveLoadModule 桩 → require 随包的 draco_wasm_wrapper.js 真字节；
// __tveInstantiateWasmFile 桩 → 读随包 draco_decoder.wasm 真字节 → 原生
// WebAssembly.instantiate，对齐桥接平台端点的兜底语义）解码 → 断言顶点/索引
// 与源数据一致（量化误差容忍）。另含两条负路径（坏字节报错、钩子缺席报错）。
// 旧方案（wasm 腿 + worker 仿真）就是在「每轮 vm 复刻都过、模拟器实跑才红」
// 上翻的车——本冒烟让每次微信构建都对真实解码链回归一次。
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

// ---- 最小 Draco 压缩 GLB（@gltf-transform + draco3dgltf 编码器）----
async function buildDracoGlb() {
  const { Document, NodeIO } = await import("@gltf-transform/core");
  const { KHRDracoMeshCompression } = await import("@gltf-transform/extensions");
  const { draco } = await import("@gltf-transform/functions");
  const encoderNs = await import("draco3dgltf");
  const createEncoderModule = encoderNs.createEncoderModule ?? encoderNs.default?.createEncoderModule;

  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const encoderModule = await createEncoderModule();
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc
    .createAccessor("POSITION")
    .setType("VEC3")
    .setArray(positions)
    .setBuffer(buffer);
  const indices = doc
    .createAccessor("indices")
    .setType("SCALAR")
    .setArray(new Uint16Array([0, 1, 2]))
    .setBuffer(buffer);
  const prim = doc.createPrimitive().setAttribute("POSITION", position).setIndices(indices);
  const mesh = doc.createMesh("M").addPrimitive(prim);
  const node = doc.createNode("N").setMesh(mesh);
  doc.createScene("S").addChild(node);

  await doc.transform(draco({ encoderModule }));
  const io = new NodeIO()
    .registerExtensions([KHRDracoMeshCompression])
    .registerDependencies({ "draco3d.encoder": encoderModule });
  return { glb: await io.writeBinary(doc), positions };
}

/** 从 GLB 提取 Draco 压缩字节与 unique-ID 属性表（对齐 GLTFLoader 扩展的取数） */
function extractDracoPayload(glb) {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error("非 GLB（magic 不符）");
  let json = null;
  let bin = null;
  let offset = 12;
  while (offset < glb.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(glb.subarray(start, start + length)));
    else if (type === 0x004e4942) bin = glb.subarray(start, start + length);
    offset = start + length + ((8 - (length % 8)) % 8);
  }
  const prim = json.meshes[0].primitives[0];
  const ext = prim.extensions["KHR_draco_mesh_compression"];
  const bufferView = json.bufferViews[ext.bufferView];
  const byteOffset = bufferView.byteOffset ?? 0;
  const bytes = bin.subarray(byteOffset, byteOffset + bufferView.byteLength).slice();
  return { bytes, attributeIDs: { position: ext.attributes.POSITION } };
}

async function main() {
  const wrapperPath = process.argv[2];
  const wasmPath = process.argv[3];
  if (!wrapperPath || !wasmPath) {
    throw new Error("用法: node draco-smoke.mjs <随包 draco_wasm_wrapper.js 路径> <随包 draco_decoder.wasm 路径>");
  }
  const expectedSpec = "tve:engine/runtime/loaders/draco/draco_wasm_wrapper.js";
  const expectedWasmPath = "engine/runtime/loaders/draco/draco_decoder.wasm";
  let pass = 0;
  let fail = 0;
  const check = (name, ok, detail = "") => {
    if (ok) {
      pass++;
      console.log(`PASS ${name}`);
    } else {
      fail++;
      console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    }
  };

  const { DracoInlineLoader } = await import("../../../src/runtime/runtime/loaders/draco-inline.ts");
  const { glb, positions } = await buildDracoGlbPositionCache();
  const { bytes, attributeIDs } = extractDracoPayload(glb);

  // 桩 = 微信桥接的 __tveLoadModule 语义（require 包内模块）。node 22 会把本
  // 仓库 "type":"module" 作用域下的 .js 按 ESM 解析（require(esm) 返回空命名
  // 空间，UMD 尾的 module.exports 赋值落空）——拷成 .cjs 临时文件强制 CJS 语义，
  // 字节与随包产物一致，也更贴近微信工具的 CJS 模块包装形态
  const require = createRequire(import.meta.url);
  const cjsCopy = path.join(tmpdir(), `tve-draco-smoke-${process.pid}.cjs`);
  fs.copyFileSync(path.resolve(wrapperPath), cjsCopy);
  globalThis.__tveLoadModule = (spec) => {
    if (spec !== expectedSpec) return Promise.reject(new Error(`意外说明符: ${spec}`));
    try {
      return Promise.resolve(require(cjsCopy));
    } catch (e) {
      return Promise.reject(e);
    }
  };
  // 桩 = 微信桥接的 __tveInstantiateWasmFile 语义（包内路径 → 读包文件字节 →
  // 实例化，返回 {module, instance}；对齐 platforms/wechat.ts 的原生 WebAssembly
  // 兜底腿）。wasm 真字节来自随包产物
  globalThis.__tveInstantiateWasmFile = (pkgPath, imports) => {
    if (pkgPath !== expectedWasmPath) return Promise.reject(new Error(`意外 wasm 路径: ${pkgPath}`));
    return Promise.resolve(WebAssembly.instantiate(new Uint8Array(fs.readFileSync(path.resolve(wasmPath))), imports));
  };

  const loader = new DracoInlineLoader();
  loader.preload();
  const { BufferGeometry } = await import("three");
  const geometry = await new Promise((resolve, reject) => {
    loader.decodeDracoFile(bytes.buffer, resolve, attributeIDs, { position: "Float32Array" }, "srgb-linear", reject);
  });
  check("解码：BufferGeometry 就位", geometry instanceof BufferGeometry);
  const attr = geometry.getAttribute("position");
  check("解码：顶点数 = 3", attr.count === 3, `实际 ${attr.count}`);
  check("解码：索引数 = 3", geometry.getIndex().count === 3, `实际 ${geometry.getIndex().count}`);
  let maxErr = 0;
  for (let i = 0; i < 9; i++) maxErr = Math.max(maxErr, Math.abs(attr.array[i] - positions[i]));
  check("解码：坐标回读一致（量化容忍 1e-3）", maxErr < 1e-3, `最大偏差 ${maxErr}`);
  check("接口：dispose 幂等返回 this", loader.dispose() === loader);

  // 负路径 1：坏字节 → 解码报错（经 onError 面）
  const badError = await new Promise((resolve) => {
    loader.decodeDracoFile(new ArrayBuffer(64), () => resolve(null), attributeIDs, { position: "Float32Array" }, "srgb-linear", resolve);
  });
  check("负路径：坏字节报错", badError instanceof Error, String(badError));

  // 负路径 2：wasm 实例化失败 → 明确报错而非悬挂（wrapper 丢弃 instantiateWasm
  // 的返回 Promise，拒绳必须由 draco-inline 自行接走——换新实例隔离模块缓存）
  const wasmHook = globalThis.__tveInstantiateWasmFile;
  globalThis.__tveInstantiateWasmFile = () => Promise.reject(new Error("模拟实例化失败"));
  const wasmError = await new Promise((resolve) => {
    new DracoInlineLoader().decodeDracoFile(bytes.buffer, () => resolve(null), attributeIDs, { position: "Float32Array" }, "srgb-linear", resolve);
  });
  globalThis.__tveInstantiateWasmFile = wasmHook;
  check("负路径：wasm 实例化失败报错", wasmError instanceof Error && String(wasmError).includes("实例化失败"), String(wasmError));

  // 负路径 3：桥接钩子缺席 → 明确报错（换新实例隔离模块缓存）
  delete globalThis.__tveLoadModule;
  const hookError = await new Promise((resolve) => {
    new DracoInlineLoader().decodeDracoFile(bytes.buffer, () => resolve(null), attributeIDs, { position: "Float32Array" }, "srgb-linear", resolve);
  });
  check("负路径：钩子缺席报错", hookError instanceof Error && String(hookError).includes("__tveLoadModule"), String(hookError));

  console.log(`[draco-smoke] ${pass} 通过 / ${fail} 失败`);
  if (fail) process.exitCode = 1;
}

// 编码 fixture 的坐标源只造一次（buildDracoGlb 每次返回新实例，坐标恒定）
let positionCache = null;
async function buildDracoGlbPositionCache() {
  positionCache ??= await buildDracoGlb();
  return positionCache;
}

main().catch((e) => {
  console.error(`[draco-smoke] 运行失败: ${e instanceof Error ? e.stack : e}`);
  process.exit(1);
});
