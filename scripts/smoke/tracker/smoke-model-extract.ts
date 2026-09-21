// ---------------------------------------------------------------------------
// @priority P0
// 模型材质提取/替换冒烟测试（headless）。
// 覆盖三段：
// ① 提取管线核心：extractMaterialDocs（材质名回退 / 线性→sRGB 换算 / 金属粗糙
//    贴图双通道 / alpha 模式 / 贴图字节与 mime / 未命名材质回退）；
// ② 覆盖表数据层：MeshNode.modelMaterialOverrides 序列化往返 / clone 隔离 /
//    旧场景兼容（空表不落盘）/ 场景 JSON 收集（collectModelMaterialOverrideRels）；
// ③ 契约：同步器（applyModelMaterialOverrides / 缓存失效 / 局部刷新）、引擎
//    （refreshMaterialNodes 模型覆盖分支）、检查器（提取按钮 + 槽位下拉）、
//    资产菜单（提取材质动作）、装载预取、统一入口动态注册。
// 跑法：pnpm smoke model-extract
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Document } from "@gltf-transform/core";
import { extractMaterialDocs } from "../../../src/app/lib/model-extract";
import {
  cloneModelMaterialOverrides,
  collectModelMaterialOverrideRels,
  parseModelMaterialOverrides,
} from "../../../src/framework/mesh/types";
import { MeshNode } from "../../../src/framework/prototype/derived/Primitives";
import { createDefaultRegistry } from "../../../src/framework/prototype/PrototypeRegistry";
import { createSuite } from "../harness.mjs";

const { check, finish } = createSuite();

/** 与 glTF 同源的线性→sRGB 单通道换算（测试独立实现，交叉验证） */
function srgb255(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}

// ===========================================================================
console.log("[1] 提取管线核心：extractMaterialDocs");
{
  const doc = new Document();
  doc.createBuffer("buf");
  // 材质 A：命名 + 全套参数 + 贴图
  const texBytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const tex = doc
    .createTexture("baseTex")
    .setImage(texBytes)
    .setMimeType("image/png");
  const matA = doc
    .createMaterial("Gold")
    .setBaseColorFactor([0.7, 0.5, 0.3, 1])
    .setMetallicFactor(0.9)
    .setRoughnessFactor(0.2)
    .setBaseColorTexture(tex)
    .setMetallicRoughnessTexture(tex);
  // 材质 B：未命名 + BLEND 透明 + emissive
  const matB = doc
    .createMaterial()
    .setBaseColorFactor([0.1, 0.2, 0.3, 0.5])
    .setAlphaMode("BLEND")
    .setEmissiveFactor([0.2, 0.1, 0]);
  const mesh = doc.createMesh("m").addPrimitive(
    doc.createPrimitive().setMaterial(matA).setMaterial(matB),
  );
  doc.createNode("n").setMesh(mesh);

  const out = extractMaterialDocs(doc);
  check("提取出 2 个材质", out.length === 2);
  const [a, b] = out;

  check("命名保留 + 未命名回退 Material 2", a.name === "Gold" && b.name === "Material 2");
  check("线性色 → sRGB hex", a.params.color === ((srgb255(0.7) << 16) | (srgb255(0.5) << 8) | srgb255(0.3)),
    `0x${a.params.color.toString(16)}`);
  check("不是线性直出（sRGB 提亮中调）", a.params.color !== ((178 << 16) | (128 << 8) | 77));
  check("金属度/粗糙度透传", a.params.metalness === 0.9 && a.params.roughness === 0.2);
  check("metallicRoughness 贴图 → 双通道同 rel 字节",
    !!a.images.metalnessMap && !!a.images.roughnessMap
    && a.images.metalnessMap === a.images.map);
  check("贴图字节与 mime 保留", a.images.map?.bytes.length === texBytes.length
    && a.images.map?.ext === "png");
  check("BLEND → opacity 透传 alpha", b.params.opacity === 0.5 && b.params.alphaClipThreshold === 0);
  check("emissive 换算 + 自发光开关", b.params.emissionEnabled
    && b.params.emissive === ((srgb255(0.2) << 16) | (srgb255(0.1) << 8) | srgb255(0)));

  // MASK 模式 → alphaClipThreshold = cutoff
  const matC = doc.createMaterial("Cutout").setBaseColorFactor([1, 1, 1, 1]).setAlphaMode("MASK").setAlphaCutoff(0.4);
  doc.createPrimitive().setMaterial(matC);
  const out2 = extractMaterialDocs(doc);
  const cut = out2.find((m) => m.name === "Cutout");
  check("MASK → alphaClipThreshold = cutoff", !!cut && cut.params.alphaClipThreshold === 0.4 && cut.params.opacity === 1);
}

// ===========================================================================
console.log("[2] 覆盖表数据层：MeshNode 序列化 / 收集");
{
  const registry = createDefaultRegistry();
  const node = registry.create("meshNode") as MeshNode;
  node.source = "model";
  node.model = "assets/models/a.glb";
  node.modelMaterialOverrides = { Hull: "assets/materials/a_Hull.mat" };
  const back = registry.createFromJSON(JSON.parse(JSON.stringify(node.toJSON()))) as MeshNode;
  check("覆盖表 JSON 往返", back instanceof MeshNode
    && back.modelMaterialOverrides.Hull === "assets/materials/a_Hull.mat");

  const legacy = registry.createFromJSON({ type: "meshNode", id: "n1", source: "model" }) as MeshNode;
  check("旧场景缺覆盖表兼容（空表）", Object.keys(legacy.modelMaterialOverrides).length === 0);
  check("空表不写入 JSON（字节兼容）", !("modelMaterialOverrides" in legacy.toJSON()));

  const cloned = node.clone();
  cloned.modelMaterialOverrides.Hull = "changed";
  check("clone 深拷贝隔离", node.modelMaterialOverrides.Hull === "assets/materials/a_Hull.mat");

  check("parse 收敛（丢弃空值）", (() => {
    const p = parseModelMaterialOverrides({ A: "assets/a.mat", B: "", C: 3 });
    return Object.keys(p).length === 1 && p.A === "assets/a.mat";
  })());
  const c1 = cloneModelMaterialOverrides(node.modelMaterialOverrides);
  c1.Hull = "x";
  check("clone 助手隔离", node.modelMaterialOverrides.Hull === "assets/materials/a_Hull.mat");

  const sceneJson = {
    root: {
      type: "group",
      children: [
        { type: "meshNode", modelMaterialOverrides: { Body: "assets/m1.mat" } },
        { type: "group", children: [{ type: "meshNode", modelMaterialOverrides: { Rim: "assets/m2.mat", Bad: "" } }] },
      ],
    },
  };
  const rels = collectModelMaterialOverrideRels(sceneJson);
  check("场景 JSON 收集覆盖引用（去重/丢空）", rels.includes("assets/m1.mat") && rels.includes("assets/m2.mat")
    && rels.length === 2);
}

// ===========================================================================
console.log("[3] 契约：同步器 / 引擎 / 检查器 / 菜单 / 预取");
{
  const syncSrc = readFileSync(resolve(process.cwd(), "src/framework/engine/modules/SceneSynchronizer.ts"), "utf8");
  check("同步器：覆盖应用（实例挂载与复用路径）", /applyModelMaterialOverrides/.test(syncSrc)
    && /__origMaterials/.test(syncSrc));
  check("同步器：覆盖材质缓存 + 失效 + 局部刷新", /modelOverrideMaterials/.test(syncSrc)
    && /invalidateModelOverrideMaterial/.test(syncSrc) && /refreshModelMeshMaterials/.test(syncSrc));

  const engineSrc = readFileSync(resolve(process.cwd(), "src/framework/engine/EditorEngine.ts"), "utf8");
  check("引擎：材质变更联动模型覆盖刷新", /invalidateModelOverrideMaterial\(rel\)/.test(engineSrc)
    && /refreshModelMeshMaterials\(node\)/.test(engineSrc));

  const menu = readFileSync(resolve(process.cwd(), "src/app/lib/asset-menu.ts"), "utf8");
  check("资产菜单：提取材质动作", /提取材质为编辑器材质/.test(menu) && /onExtractModelMaterials/.test(menu));

  const section = readFileSync(resolve(process.cwd(), "src/app/components/inspector/ModelMaterialSection.vue"), "utf8");
  check("检查器：提取按钮 + 槽位下拉", /提取材质到编辑器/.test(section) && /Set Model Material Slot/.test(section));

  const service = readFileSync(resolve(process.cwd(), "src/app/services/editorService.ts"), "utf8");
  check("装载预取：覆盖引用并入材质预取", /collectModelMaterialOverrideRels/.test(service));

  const runner = resolve(process.cwd(), "scripts", "smoke", "runner.mjs");
  check("统一入口 runner.mjs 已就位（本脚本由其动态发现）", existsSync(runner));
}

// ===========================================================================
finish();
