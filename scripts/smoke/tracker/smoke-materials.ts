// ---------------------------------------------------------------------------
// @priority P0
// 材质/天空材质判别冒烟测试（Node 运行；vite --ssr 打包）：
// 天空材质的判别**只**取决于 shader 是否引用天空着色器（或 kind 字段显式声明），
// 普通材质（引用 PBR/Unlit/卡通/项目效果着色器）绝不能被判成天空材质
// —— 历史缺陷：判别条件写过「shader 是不是 .shader 引用」，导致新建材质
// （shader = internal/shaders/PBR.shader）在资产检查器里显示成立方体天空盒材质。
// 覆盖三处读取器（同一规则）：应用层 sky-mat.ts、引擎 skyboxTextures.ts、
// 网页运行时 engine/runtime/sky.mjs。
// 运行：pnpm smoke materials
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { parseSkyMatDoc } from "../../../src/app/lib/sky-mat";
import { fetchSkyMatParams } from "../../../src/framework/engine/modules/skyboxTextures";
import { DEFAULT_SHADER_REL, skyKindOfShaderRef } from "../../../src/framework/material";
import { loadSkyMatParams } from "../../../public/engine/runtime/sky.mjs";
import { createSuite } from "../harness.mjs";

const { ok, finish } = createSuite();

/** 构造 .mat 文本（只带判别相关字段） */
const mat = (fields: Record<string, unknown>): string =>
  JSON.stringify({ $type: "material", $ver: 1, name: "M", ...fields });

/** 普通材质（新建材质 / 各类内置分支）样例 */
const PLAIN_MATS: [string, string][] = [
  // 新建材质挂的正是 DEFAULT_SHADER_REL（内置 PBR 引用）——本次回归的正是这条
  ["新建材质（内置 PBR 引用）", mat({ shader: DEFAULT_SHADER_REL, color: "#9aa4b2" })],
  ["内置 Unlit 引用", mat({ shader: "internal/shaders/Unlit.shader" })],
  ["内置卡通引用", mat({ shader: "internal/shaders/Toon.shader" })],
  ["项目着色器引用（带 Properties 参数）", mat({ shader: "assets/shaders/RimLight.shader", props: { _RimPower: 3 } })],
  ["名字里带 SkyBox 的普通着色器", mat({ shader: "assets/shaders/MySkyBox.shader" })],
  ["名字里带 SkyProcedural 的普通着色器", mat({ shader: "assets/shaders/MySkyProcedural.shader" })],
  ["无 shader / 无 kind 的旧材质", mat({ color: "#ffffff" })],
];

/** 天空材质样例（新格式引用 / 旧格式魔法串 / kind 显式声明） */
const SKY_MATS: [string, Record<string, unknown>, "cube" | "procedural"][] = [
  ["立方体天空盒（引用）", { shader: "internal/shaders/SkyBox.shader" }, "cube"],
  ["程序化天空（引用）", { shader: "internal/shaders/SkyProcedural.shader" }, "procedural"],
  ["立方体天空盒（旧魔法串）", { shader: "SkyBox" }, "cube"],
  ["程序化天空（旧魔法串）", { shader: "SkyProcedural" }, "procedural"],
  ["kind 显式声明 cube", { kind: "cube", shader: "internal/shaders/SkyBox.shader" }, "cube"],
  ["kind 显式声明 procedural", { kind: "procedural" }, "procedural"],
  [
    "kind 优先于引用（kind=cube + 程序化引用）",
    { kind: "cube", shader: "internal/shaders/SkyProcedural.shader" },
    "cube",
  ],
];

async function main(): Promise<void> {
  // —— 1. 规则谓词本身 ——
  console.log("[1] skyKindOfShaderRef（判别谓词）");
  ok(skyKindOfShaderRef("internal/shaders/SkyBox.shader") === "cube", "天空盒着色器引用 → cube");
  ok(
    skyKindOfShaderRef("internal/shaders/SkyProcedural.shader") === "procedural",
    "程序化天空引用 → procedural",
  );
  ok(
    skyKindOfShaderRef("SkyBox") === "cube" && skyKindOfShaderRef("SkyProcedural") === "procedural",
    "旧魔法串仍识别",
  );
  ok(skyKindOfShaderRef("internal/shaders/PBR.shader") === null, "普通着色器引用 → null");
  ok(
    skyKindOfShaderRef("assets/shaders/MySkyBox.shader") === null,
    "文件名相近的着色器 → null（按文件名精确匹配）",
  );
  ok(skyKindOfShaderRef("") === null, "空引用 → null");

  // —— 2. 资产检查器（app/lib/sky-mat.ts） ——
  console.log("[2] parseSkyMatDoc（资产检查器）");
  for (const [label, text] of PLAIN_MATS) {
    ok(parseSkyMatDoc(text) === null, `普通材质不是天空材质：${label}`);
  }
  for (const [label, fields, kind] of SKY_MATS) {
    ok(parseSkyMatDoc(mat(fields))?.kind === kind, `天空材质 kind 正确：${label}`);
  }
  ok(parseSkyMatDoc('{"$type":"scene"}') === null, "非材质文档 → null");
  ok(parseSkyMatDoc("not json") === null, "非 JSON → null");

  // —— 2b. 真实内置资产（public/internal/materials）分类正确 ——
  console.log("[2b] 内置材质资产分类");
  const internalMat = (file: string): string =>
    readFileSync(`public/internal/materials/${file}`, "utf8");
  ok(parseSkyMatDoc(internalMat("Default.mat")) === null, "内置 Default.mat 不是天空材质");
  ok(parseSkyMatDoc(internalMat("ProceduralSky.mat"))?.kind === "procedural", "内置 ProceduralSky.mat → procedural");
  ok(parseSkyMatDoc(internalMat("SkyBox.mat"))?.kind === "cube", "内置 SkyBox.mat → cube");

  // —— 3. 引擎（framework/engine/modules/skyboxTextures.ts） ——
  console.log("[3] fetchSkyMatParams（编辑器引擎）");
  const docs = new Map<string, unknown>();
  for (const [label, text] of PLAIN_MATS) docs.set(`plain-${label}.mat`, JSON.parse(text));
  for (const [label, fields] of SKY_MATS) docs.set(`sky-${label}.mat`, JSON.parse(mat(fields)));
  globalThis.fetch = (async (url: string) => {
    const key = String(url).replace(/^\.\//, "");
    if (!docs.has(key)) return { ok: false, status: 404, json: async () => null };
    return { ok: true, status: 200, json: async () => docs.get(key) };
  }) as unknown as typeof fetch;

  for (const [label] of PLAIN_MATS) {
    ok(
      (await fetchSkyMatParams(`./plain-${label}.mat`)) === null,
      `引擎不把普通材质当天空：${label}`,
    );
  }
  for (const [label, , kind] of SKY_MATS) {
    ok(
      (await fetchSkyMatParams(`./sky-${label}.mat`))?.kind === kind,
      `引擎识别天空材质：${label}`,
    );
  }

  // —— 4. 网页运行时（public/engine/runtime/sky.mjs，同规则镜像） ——
  console.log("[4] loadSkyMatParams（网页运行时）");
  for (const [label] of PLAIN_MATS) {
    ok(
      (await loadSkyMatParams(`./plain-${label}.mat`)) === null,
      `运行时不当天空材质：${label}`,
    );
  }
  for (const [label, , kind] of SKY_MATS) {
    ok(
      (await loadSkyMatParams(`./sky-${label}.mat`))?.kind === kind,
      `运行时识别天空材质：${label}`,
    );
  }

  finish();
}

void main();
