import { describe, expect, it } from "vitest";
import { compileScript } from "./compile";
import { compileScriptWechat } from "./wechat";

// 微信渠道脚本编译变体：CJS 产物 + tve 门面指向 engine/core/tve.js + 相对说明符
// 小写补 .js（包内注册表小写归一）；web 渠道默认编译路径不受影响。

describe("compileScriptWechat", () => {
  it("正常：默认导出类编译为 CJS（exports.default，无 import/export 语句）", async () => {
    const { js, error } = await compileScriptWechat(
      `export default class Main { start() {} }\n`,
      "src/main.ts",
    );
    expect(error).toBeNull();
    expect(js).toContain("exports.default");
    expect(js).not.toMatch(/(^|\n)\s*export\s+default/);
    expect(js).not.toMatch(/(^|\n)\s*import\s/);
  });

  it("正常：tve 裸导入指向包内 CJS 门面 engine/core/tve.js", async () => {
    const { js } = await compileScriptWechat(`import { engine } from "tve";\nengine.log("x");\n`, "src/main.ts");
    expect(js).toContain('require("../engine/core/tve.js")');
  });

  it("正常：子目录脚本的 tve 相对路径按目录深度推导", async () => {
    const { js } = await compileScriptWechat(`import { engine } from "tve";\nengine.log("x");\n`, "src/ui/button.ts");
    expect(js).toContain('require("../../engine/core/tve.js")');
  });

  it("正常：相对导入说明符小写 + 补 .js 扩展名", async () => {
    const { js } = await compileScriptWechat(
      `import Util from "./Util";\nimport Val from "../shared/Val";\nexport default class A { use() { return Util.x + Val.y; } }\n`,
      "src/main.ts",
    );
    expect(js).toContain('require("./util.js")');
    expect(js).toContain('require("../shared/val.js")');
    expect(js).not.toContain('require("./Util")');
  });

  it("边界：已有 .js/.ts 扩展名的相对导入不重复叠加", async () => {
    const { js } = await compileScriptWechat(
      `import A from "./Helper.ts";\nimport B from "./Other.js";\nexport default class C { use() { return A.x + B.y; } }\n`,
      "src/main.ts",
    );
    expect(js).toContain('require("./helper.js")');
    expect(js).toContain('require("./other.js")');
  });

  it("正常：组件字段元数据注入与 web 渠道一致（__tveComponentKeys）", async () => {
    const src = `import type { RigidBody } from "tve";\nexport default class Foe {\n  body!: RigidBody;\n}\n`;
    const { js, error } = await compileScriptWechat(src, "src/foe.ts");
    expect(error).toBeNull();
    expect(js).toContain("__tveComponentKeys");
    expect(js).toContain("rigidBody");
  });

  it("正常：原始类名注入为字符串静态字段（__tveClassName；下游 minified 混淆免疫锚点）", async () => {
    const src = `export default class MyJoystick {\n  dirX = 0;\n}\n`;
    const { js, error } = await compileScriptWechat(src, "src/myjoystick.ts");
    expect(error).toBeNull();
    expect(js).toContain('__tveClassName = "MyJoystick"');
    // 静态字段挂在类体内（CJS 产物 class 声明处），非模块级附加导出
    expect(js).toContain("class MyJoystick");
  });

  it("边界：匿名默认导出类不注入类名元数据", async () => {
    const src = `export default class {\n  x = 1;\n}\n`;
    const { js, error } = await compileScriptWechat(src, "src/anon.ts");
    expect(error).toBeNull();
    expect(js).not.toContain("__tveClassName");
  });

  it("异常：语法错误返回诊断、产物为空", async () => {
    const { js, error } = await compileScriptWechat(`export default class {\n`, "src/bad.ts");
    expect(js).toBe("");
    expect(error).toBeTruthy();
  });
});

describe("compileScript 渠道分流", () => {
  it("正常：target=wechat 与 compileScriptWechat 产物一致", async () => {
    const src = `import { engine } from "tve";\nengine.log("x");\nexport default class M {}\n`;
    const viaTarget = await compileScript(src, "src/main.ts", { target: "wechat" });
    const direct = await compileScriptWechat(src, "src/main.ts");
    expect(viaTarget.js).toBe(direct.js);
    expect(viaTarget.js).toContain('require("../engine/core/tve.js")');
  });

  it("正常：默认（web）路径保持 ESM 产物，不经微信改写", async () => {
    const src = `import { engine } from "tve";\nimport U from "./Util";\nexport default class M { use() { engine.log(U.x); } }\n`;
    const { js } = await compileScript(src, "src/main.ts");
    expect(js).toContain('from "../engine/core/tve.mjs"');
    expect(js).toContain('from "./Util"');
    expect(js).not.toContain("require(");
  });
});
