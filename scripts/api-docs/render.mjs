// 文档数据模型 → Markdown（public/docs/sdk/api.md 的正文）。
// 形状约定：interface/enum 用成员表格（说明压一行）；class 成员说明较长
// （含示例代码），逐成员小节展开；type/const 给声明代码块；function 每个
// 重载一个签名代码块。

// 表格单元格内不能有竖线与换行
const cell = (s) => s.replace(/\r?\n\s*/g, " ").replace(/\|/g, "\\|").trim();

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
      return m.doc ? `${head}\n\n${m.doc}` : head;
    })
    .join("\n\n");
}

const fence = (code) => ["```ts", code, "```"].join("\n");

function renderDecl(decl) {
  switch (decl.kind) {
    case "class":
      return [`### ${decl.header}`, decl.doc, renderMemberList(decl)];
    case "interface":
    case "enum":
      return [`### ${decl.header}`, decl.doc, renderMemberTable(decl)];
    case "type":
    case "const":
      return [`### ${decl.name}`, fence(decl.decl), decl.doc];
    case "function":
      return [`### ${decl.name}()`, fence(decl.sig), decl.doc];
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
