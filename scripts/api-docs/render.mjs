// 文档数据模型 → Markdown（public/docs/sdk/api.md 的正文）。
// 形状约定：interface/enum 用成员表格（说明压一行）；class 成员说明较长
// （含示例代码），逐成员小节展开；type/const 给声明代码块；function 每个
// 重载一个签名代码块。
// 声明级示例：examples/<声明名>.md 存在时注入到说明之后（示例块用 ```ts tve
// 标记，随 scripts/docs-tests 一并纳管——见 scripts/docs-tests/README.md）。

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), "examples");

// 声明 kind → 示例子目录。分子目录除了组织清晰，还规避 Windows 大小写
// 不敏感文件系统下的同名冲突（const tween 与 class Tween）。
const KIND_DIR = {
  class: "classes",
  interface: "interfaces",
  enum: "interfaces",
  type: "values",
  const: "values",
  function: "values",
};

// 表格单元格内不能有竖线与换行
const cell = (s) => s.replace(/\r?\n\s*/g, " ").replace(/\|/g, "\\|").trim();

/** doc 正文里的 ```ts 示例块升级为 ```ts tve（随 docs-tests 纳管）。
 *  行首锚定避免误改行文中的反引号文本。 */
function upgradeDocFences(doc) {
  return doc.replace(/^```ts$/gm, "```ts tve");
}

/** 读取声明示例片段（无则空串）；首尾空白收敛为单换行 */
export function exampleOf(name, kind = "class") {
  const file = join(EXAMPLES_DIR, KIND_DIR[kind] ?? "values", `${name}.md`);
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8").replace(/\s+$/, "");
}

/** interface / enum 成员表 */
function renderMemberTable(decl) {
  const rows = decl.members.map((m) => {
    const type = m.type ? cell(m.type.startsWith(":") ? m.type.slice(2) : m.type) : "";
    return `| \`${cell(m.name)}\` | ${type ? `\`${type}\`` : ""} | ${cell(m.doc)} |`;
  });
  return ["| 成员 | 类型 | 说明 |", "| --- | --- | --- |", ...rows].join("\n");
}

/** class 成员逐条展开（签名行 + 完整说明，可含示例代码块） */
function renderMemberList(decl) {
  return decl.members
    .map((m) => {
      const type = m.type.startsWith(":") ? m.type : m.type ? `: ${m.type}` : "";
      const head = `#### \`${cell(m.name)}${type}\``;
      return m.doc ? `${head}\n\n${upgradeDocFences(m.doc)}` : head;
    })
    .join("\n\n");
}

const fence = (code) => ["```ts", code, "```"].join("\n");

function renderDecl(decl) {
  const example = exampleOf(decl.name, decl.kind);
  const exampleBlock = example ? `**示例**（doctest：随文档测试套件逐块验证）\n\n${upgradeDocFences(example)}` : "";
  switch (decl.kind) {
    case "class":
      return [`### ${decl.header}`, upgradeDocFences(decl.doc), exampleBlock, renderMemberList(decl)];
    case "interface":
    case "enum":
      return [`### ${decl.header}`, upgradeDocFences(decl.doc), exampleBlock, renderMemberTable(decl)];
    case "type":
    case "const":
      return [`### ${decl.name}`, fence(decl.decl), upgradeDocFences(decl.doc), exampleBlock];
    case "function":
      return [`### ${decl.name}()`, fence(decl.sig), upgradeDocFences(decl.doc), exampleBlock];
    default:
      return [];
  }
}

export function renderModel(model) {
  const parts = [];
  if (model.header) parts.push(model.header.split("\n").map((l) => `> ${l}`).join("\n"));
  for (const section of model.sections) {
    const body = section.decls.map(renderDecl).map((blocks) => blocks.filter(Boolean).join("\n\n"));
    parts.push([`## ${section.title}`, section.intro, ...body].filter(Boolean).join("\n\n"));
  }
  return parts.join("\n\n") + "\n";
}
