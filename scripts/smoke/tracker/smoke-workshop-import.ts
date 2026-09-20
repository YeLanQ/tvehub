// ---------------------------------------------------------------------------
// 创意工坊「导入」命名冒烟测试（Node 运行；vite --ssr 打包）：
// 编辑器里使用工坊内容不再弹命名窗——选一项就按**源文件名**落一份同名资产，
// 重名由创建链路自动加后缀。本套件锁住这条链路上的三个可回归点：
//   1. 文件名 → 类名（PascalCase）规则：类名恒等于文件名，去重后的
//      "Rotator 2.ts" 类名必须是 "Rotator2"（而不是沿用原文件名——同名类会让
//      场景里的 `script:<类名>` 标识歧义）；
//   2. 脚本导入：落盘 src/<源文件名>.ts 且注入类名与 {{CLASS_NAME}} 替换正确；
//   3. 着色器导入：落盘 <目录>/<源文件名>.shader（指令名由后端随路径同步），
//      守卫（src/ 与内置目录）仍然拦截。
// 运行：pnpm smoke workshop-import
// ---------------------------------------------------------------------------
import { assetService } from "../../../src/app/services/assetService";
import { scriptClassNameFromStem } from "../../../src/app/lib/script-prototypes";
import { api, type AssetEntry } from "../../../src/lib/api";
import { createSuite } from "../harness.mjs";

const { ok, finish } = createSuite();

/** 资产条目桩（只需 path / kind） */
const asset = (path: string): AssetEntry => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  kind: path.slice(path.lastIndexOf(".") + 1),
  size: 0,
});

/** 工坊脚本原型（与 public/repos/code/*.ts 同形：类名占位符 + 首部描述） */
const protoCode = (desc: string): string =>
  `// @desc: ${desc}\nimport { Component } from "tve";\n\nexport default class {{CLASS_NAME}} extends Component {}\n`;

async function main(): Promise<void> {
  // 桩后端：拦写入以断言落盘路径与内容（真实写盘由后端 shader_write_source /
  // writeText 完成，与命名规则无关）
  const written = new Map<string, string>();
  const shaderWrites: { rel: string; source: string }[] = [];
  const realWriteText = api.writeText;
  const realShaderWriteSource = api.shaderWriteSource;
  api.writeText = async (_root: string, rel: string, content: string) => {
    written.set(rel, content);
  };
  api.shaderWriteSource = async (_root: string, rel: string, source: string) => {
    shaderWrites.push({ rel, source });
    return null as never;
  };

  console.log("[1] 文件名 → 类名（PascalCase）规则");
  ok(scriptClassNameFromStem("Rotator") === "Rotator", "原样名：Rotator → Rotator");
  ok(scriptClassNameFromStem("Rotator 2") === "Rotator2", "去重名：Rotator 2 → Rotator2（去掉空格）");
  ok(scriptClassNameFromStem("camera_follow") === "CameraFollow", "下划线分词：camera_follow → CameraFollow");
  ok(scriptClassNameFromStem("scan-line") === "ScanLine", "连字符分词：scan-line → ScanLine");
  ok(scriptClassNameFromStem("角色控制器") === "MyScript", "无 ASCII 字母：回退 MyScript");
  ok(scriptClassNameFromStem("", "Main") === "Main", "空名：回退调用方给的 fallback");

  console.log("[2] 脚本导入：按源文件名落盘 src/");
  written.clear();
  const scriptRel = await assetService.createScriptAsset(
    "C:/tmp/proj",
    "src",
    "Rotator",
    [],
    { id: "Rotator.ts", name: "Rotator", description: "", code: protoCode("绕 Y 轴匀速自转") },
  );
  ok(scriptRel === "src/Rotator.ts", `落盘路径 = 源文件名（得到 ${scriptRel}）`);
  const firstContent = written.get(scriptRel ?? "") ?? "";
  ok(firstContent.includes("export default class Rotator"), "默认导出类名 = Rotator");
  ok(!firstContent.includes("{{CLASS_NAME}}"), "占位符已替换（不残留 {{CLASS_NAME}}）");
  ok(firstContent.includes("// @desc: 绕 Y 轴匀速自转"), "原型首部 @desc 随源码保留");

  console.log("[3] 重名导入：自动加后缀且类名跟文件名");
  written.clear();
  const dupRel = await assetService.createScriptAsset(
    "C:/tmp/proj",
    "src",
    "Rotator",
    [asset("src/Rotator.ts")],
    { id: "Rotator.ts", name: "Rotator", description: "", code: protoCode("绕 Y 轴匀速自转") },
  );
  ok(dupRel === "src/Rotator 2.ts", `重名落盘为加后缀文件（得到 ${dupRel}）`);
  const dupContent = written.get(dupRel ?? "") ?? "";
  ok(dupContent.includes("export default class Rotator2"), "类名随去重后的文件名（Rotator2，非 Rotator）");
  ok(!/class Rotator\s+extends/.test(dupContent), "不复用原类名（避免同名类歧义）");

  console.log("[4] 着色器导入：按源文件名落盘当前目录");
  shaderWrites.length = 0;
  const shaderRel = await assetService.createShaderFromSource(
    "C:/tmp/proj",
    "assets/shaders",
    "RimLight",
    'Shader "effect/RimLight"\nBase PBR {\n}\n',
    [],
  );
  ok(shaderRel === "assets/shaders/RimLight.shader", `落盘路径 = 源文件名（得到 ${shaderRel}）`);
  ok(shaderWrites[0]?.rel === "assets/shaders/RimLight.shader", "源码写入路径一致（指令名由后端随路径同步）");
  shaderWrites.length = 0;
  const shaderDup = await assetService.createShaderFromSource(
    "C:/tmp/proj",
    "assets/shaders",
    "RimLight",
    'Shader "effect/RimLight"\nBase PBR {\n}\n',
    [asset("assets/shaders/RimLight.shader")],
  );
  ok(shaderDup === "assets/shaders/RimLight 2.shader", `重名落盘为加后缀文件（得到 ${shaderDup}）`);

  console.log("[5] 落盘守卫不被放开");
  shaderWrites.length = 0;
  ok(
    (await assetService.createShaderFromSource("C:/tmp/proj", "src", "RimLight", 'Shader "x"', [])) === null,
    "src/ 目录仍拒绝新建着色器",
  );
  ok(
    (await assetService.createShaderFromSource("C:/tmp/proj", "internal/shaders", "RimLight", 'Shader "x"', [])) ===
      null,
    "internal/ 内置目录仍只读",
  );
  ok(shaderWrites.length === 0, "被拦截时不产生任何写入");
  ok(
    (await assetService.createScriptAsset("C:/tmp/proj", "assets", "Rotator", [], undefined)) === null,
    "脚本仍只能落在 src/（destDir=assets 被拒）",
  );

  api.writeText = realWriteText;
  api.shaderWriteSource = realShaderWriteSource;
  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
