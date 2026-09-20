// tve.d.ts → 文档数据模型。用仓库自带的 typescript 编译器解析 AST，
// 按文件里的「虚线横幅注释」分节，每个顶层声明携带其 JSDoc。
// 渲染见 ./render.mjs，入口见 ../gen-api-docs.mjs。

import ts from "typescript";
import { readFileSync } from "node:fs";

// 虚线横幅：// ---- / // 标题（+ 若干 // 说明行）/ // ----
const BANNER_RE = /^[ \t]*\/\/\s*-{8,}[ \t]*\r?\n([ \t]*\/\/[^\n]*\r?\n)+[ \t]*\/\/\s*-{8,}[ \t]*(\r?\n|$)/;

/** 取 prevEnd→start 切片中最后一个 /** 块注释，去掉注释星号装饰后作为说明文本 */
function docBetween(text, prevEnd, start) {
  const matches = [...text.slice(prevEnd, start).matchAll(/\/\*\*([\s\S]*?)\*\//g)];
  if (matches.length === 0) return "";
  return matches[matches.length - 1][1]
    .split("\n")
    .map((line) => line.replace(/\r$/, "").replace(/^\s*\*\s?/, ""))
    .join("\n")
    .trim();
}

/** 成员签名：属性给类型文本，方法给完整调用签名 */
function memberSig(m) {
  if (m.kind === ts.SyntaxKind.PropertySignature || m.kind === ts.SyntaxKind.PropertyDeclaration) {
    return { name: m.name.getText() + (m.questionToken ? "?" : ""), type: m.type?.getText() ?? "" };
  }
  if (m.kind === ts.SyntaxKind.GetAccessor) {
    return { name: `get ${m.name.getText()}()`, type: m.type?.getText() ?? "" };
  }
  if (m.kind === ts.SyntaxKind.SetAccessor) {
    const p = m.parameters[0];
    return { name: `set ${m.name.getText()}(${p.getText()})`, type: "" };
  }
  const params = m.parameters.map((p) => p.getText()).join(", ");
  const name = m.name?.getText() ?? "constructor";
  return { name: `${name}(${params})`, type: m.type ? `: ${m.type.getText()}` : "" };
}

const stripExport = (t) => t.replace(/^[ \t]*(?:export|declare)[ \t]+/gm, "").trim();
const headerOf = (stmt) => stripExport(stmt.getText().slice(0, stmt.getText().indexOf("{")));

function extractDecl(stmt, text, prevEnd) {
  const doc = docBetween(text, prevEnd, stmt.getStart());
  const name = stmt.name?.getText() ?? "";

  switch (stmt.kind) {
    case ts.SyntaxKind.InterfaceDeclaration:
    case ts.SyntaxKind.ClassDeclaration: {
      const members = stmt.members.map((mem, i) => {
        // 首成员的前界用语句起点：切片里除其 JSDoc 外只有头部长不了 /** */
        const prev = i === 0 ? stmt.getStart() : stmt.members[i - 1].getEnd();
        return { ...memberSig(mem), doc: docBetween(text, prev, mem.getStart()) };
      });
      return {
        kind: stmt.kind === ts.SyntaxKind.ClassDeclaration ? "class" : "interface",
        name,
        header: headerOf(stmt),
        doc,
        members,
      };
    }
    case ts.SyntaxKind.TypeAliasDeclaration:
      return { kind: "type", name, doc, decl: stripExport(stmt.getText()) };
    case ts.SyntaxKind.EnumDeclaration:
      return {
        kind: "enum",
        name,
        doc,
        header: headerOf(stmt),
        members: stmt.members.map((mem, i) => {
          const prev = i === 0 ? stmt.getStart() : stmt.members[i - 1].getEnd();
          return { name: mem.name.getText(), type: mem.initializer?.getText() ?? "", doc: docBetween(text, prev, mem.getStart()) };
        }),
      };
    case ts.SyntaxKind.VariableStatement:
      return { kind: "const", name: stmt.declarationList.declarations[0].name.getText(), doc, decl: stripExport(stmt.getText()) };
    case ts.SyntaxKind.FunctionDeclaration: {
      const params = stmt.parameters.map((p) => p.getText()).join(", ");
      return { kind: "function", name, doc, sig: `${name}(${params})${stmt.type ? `: ${stmt.type.getText()}` : ""}` };
    }
    default:
      return null; // import 等不进文档
  }
}

/** 解析 .d.ts → { header, sections }；sections: [{ title, intro, decls }] */
export function extractModel(filePath) {
  const text = readFileSync(filePath, "utf8");
  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const banners = [];
  for (const m of text.matchAll(new RegExp(BANNER_RE.source, "gm"))) {
    const inner = m[0]
      .split(/\r?\n/)
      .filter((l) => l && !/^[ \t]*\/\/\s*-{8,}[ \t]*$/.test(l))
      .map((l) => l.replace(/^[ \t]*\/\/[ \t]?/, ""));
    // 标题行按首个句号切开：句号前的短语作节标题，余下并入节引言（标题不断在半句）
    let title = inner[0]?.trim() ?? "";
    let intro = inner.slice(1).join("\n").trim();
    const dot = title.indexOf("。");
    if (dot !== -1) {
      intro = [title.slice(dot + 1).trim(), intro].filter(Boolean).join("\n");
      title = title.slice(0, dot);
    }
    banners.push({ pos: m.index, title, intro });
  }
  const firstStart = sf.statements.length ? sf.statements[0].getStart(sf) : Infinity;
  const bodyBanners = banners.filter((b) => b.pos > firstStart);
  const header = banners
    .filter((b) => b.pos < firstStart)
    .map((b) => [b.title, b.intro].filter(Boolean).join("\n"))
    .join("\n\n");

  const preamble = { title: "基础类型", intro: "", decls: [] };
  const sections = bodyBanners.map((b) => ({ title: b.title, intro: b.intro, decls: [] }));
  let idx = -1; // 当前所属分节（-1 = 还没进任何横幅 → preamble）
  let prevEnd = 0;
  for (const stmt of sf.statements) {
    if (idx + 1 < bodyBanners.length && bodyBanners[idx + 1].pos < stmt.getStart(sf)) idx++;
    const decl = extractDecl(stmt, text, prevEnd);
    if (decl) (idx < 0 ? preamble : sections[idx]).decls.push(decl);
    prevEnd = stmt.getEnd();
  }
  return {
    header,
    sections: [preamble, ...sections].filter((s) => s.decls.length > 0),
  };
}
