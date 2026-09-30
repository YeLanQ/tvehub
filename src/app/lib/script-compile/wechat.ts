// ---------------------------------------------------------------------------
// 微信小游戏渠道脚本编译变体（C2）：
// - 产物 CommonJS（微信 require 注册表），web 渠道的 ESM 编译不受影响；
// - "tve" 裸导入 → engine/core/tve.js（包内 CJS 门面，转发预构建 bundle 的
//   __tveFacade）；
// - 相对导入说明符统一小写 + 补 .js 扩展名——包内注册表小写归一（开发者工具
//   行为），无扩展名的 require 会注册表 miss；
// - 复用 compile.ts 的组件字段元数据 transformer（导出的共享实现）。
// ---------------------------------------------------------------------------

import type * as ts from "typescript";
import type { TsModule } from "./constants";
import { loadTs } from "./constants";
import { componentFieldTransformer, type CompiledScript } from "./compile";
import { rewriteTveSpecifiers, tveImportFor } from "./paths";

/** 相对说明符 → 包内 CJS 形态：小写 + 剥现有扩展名 + 补 .js */
function normalizeRelativeSpecifier(spec: string): string {
  let out = spec.replace(/\\/g, "/").toLowerCase();
  out = out.replace(/\.(js|mjs|cjs|ts|tsx)$/i, "");
  return `${out}.js`;
}

/** AST 级重写相对导入说明符（import/export from/动态 import() 的字符串字面量） */
function rewriteRelativeSpecifiers(ts: TsModule, source: string): string {
  const sf = ts.createSourceFile("script.ts", source, ts.ScriptTarget.Latest, true);
  const edits: { start: number; end: number; text: string }[] = [];
  const collect = (literal: ts.StringLiteral): void => {
    if (literal.text.startsWith("./") || literal.text.startsWith("../")) {
      const quote = source[literal.getStart(sf)];
      edits.push({
        start: literal.getStart(sf),
        end: literal.getEnd(),
        text: `${quote}${normalizeRelativeSpecifier(literal.text)}${quote === "'" ? "'" : '"'}`,
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

/** 微信渠道编译单个脚本：CJS 转译 + tve → engine/core/tve.js + 相对说明符归一 */
export async function compileScriptWechat(
  source: string,
  scriptRel: string,
): Promise<CompiledScript> {
  const ts = await loadTs();
  // 先把 "tve" 裸导入改写为 engine/core/tve.js 的相对说明符（.js 形态），
  // 随后相对说明符归一化会顺带小写它（engine/core/tve.js 本就全小写）
  const preprocessed = rewriteTveSpecifiers(ts, source, tveImportFor(scriptRel, "engine/core/tve.js"));
  const rewritten = rewriteRelativeSpecifiers(ts, preprocessed);
  const out = ts.transpileModule(rewritten, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      strict: true,
      isolatedModules: true,
      // 装饰器（@property / @nodeType）：TS 实验性装饰器 → 运行时 __decorate
      experimentalDecorators: true,
    },
    reportDiagnostics: true,
    transformers: {
      before: [componentFieldTransformer(ts)],
    },
  });
  const first = (out.diagnostics ?? [])[0];
  if (first) {
    const msg = ts.flattenDiagnosticMessageText(first.messageText, " ");
    return { js: "", error: msg };
  }
  return { js: out.outputText, error: null };
}
