// ---------------------------------------------------------------------------
// 脚本路径映射与导入说明符重写（编译产物的路径形态）：
// - scriptJsPath：源路径（src/**.ts）→ 编译产物路径（src/**.js），供 project.ts
//   组装导出 files 时使用；
// - tveImportFor：计算从脚本目录指向运行时模块 engine/core/tve.mjs 的相对说明符；
// - rewriteTveSpecifiers（模块内共享，compile.ts 调用）：AST 级把源码中 "tve" 裸
//   导入说明符（import / export from / 动态 import()）替换为目标路径。
// 仅依赖 constants.ts（TsModule 类型）。
// ---------------------------------------------------------------------------

import type * as ts from "typescript";
import type { TsModule } from "./constants";

/** 源路径（src/**.ts）→ 编译产物路径（src/**.js） */
export function scriptJsPath(srcRel: string): string {
  return srcRel.replace(/\.tsx?$/, ".js");
}

/**
 * 计算从脚本目录指向运行时模块（engine/core/tve.mjs）的相对导入说明符。
 * @param scriptRel 脚本源路径（如 "src/main.ts"、"src/ui/button.ts"）
 */
export function tveImportFor(scriptRel: string): string {
  const dir = scriptRel.includes("/") ? scriptRel.slice(0, scriptRel.lastIndexOf("/")) : "";
  const fromParts = dir ? dir.split("/") : [];
  const toParts = "engine/core/tve.mjs".split("/");
  const file = toParts.pop() as string;
  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
    common += 1;
  }
  const ups = fromParts.length - common;
  const prefix = ups === 0 ? ["."] : Array<string>(ups).fill("..");
  return [...prefix, ...toParts.slice(common), file].join("/");
}

/** 把源码中 "tve" 导入说明符（import/export from/import()）替换为目标路径 */
// 模块内共享：由 compile.ts 的 compileScript 调用（原函数体未改动）
export function rewriteTveSpecifiers(ts: TsModule, source: string, replacement: string): string {
  const sf = ts.createSourceFile("script.ts", source, ts.ScriptTarget.Latest, true);
  const edits: { start: number; end: number; text: string }[] = [];

  const collect = (literal: ts.StringLiteral): void => {
    if (literal.text === "tve") {
      const quote = source[literal.getStart(sf)];
      edits.push({
        start: literal.getStart(sf),
        end: literal.getEnd(),
        text: `${quote}${replacement}${quote === "'" ? "'" : '"'}`,
      });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      collect(node.moduleSpecifier);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      collect(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      collect(node.arguments[0] as ts.StringLiteral);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  let out = source;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}
