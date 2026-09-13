// ---------------------------------------------------------------------------
// 类型自动导入（脚本编辑器补全）：输入引擎/脚本导出名 → 接受建议时自动写入
// import 语句，免去手写 import 的记忆负担。两层结构：
// - 导出清单解析：tve.d.ts（引擎 SDK）与全部脚本模型的 AST 导出扫描（loadTs），
//   JSDoc 注释作为建议文档；脚本模型由同目录 model-sync.ts 全量镜像；
// - Monaco 补全提供器（typescript 语言）：把命中前缀的导出名以「自动导入」项
//   呈现，additionalTextEdits 完成插入/合并（纯编辑逻辑在 auto-import-core.ts）。
//   tve 项插入 `import { X } from "tve"`（编译管线重写为运行时模块）；脚本项
//   一律 type-only（`import type X from "./x"`，编译期擦除，运行时脚本类全局
//   可见，不产生模块依赖）。
// 无法识别的场景（注释/字符串/成员访问/import 子句内）直接不产出建议。
// 进程内只注册一次（面板可反复挂载/卸载，Monaco 单例随应用存活）。
// ---------------------------------------------------------------------------

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import type * as ts from "typescript";
import type { MonacoNamespace } from "./monaco-setup";
import type { TsModule } from "../../lib/script-compile/constants";
import { loadTs } from "../../lib/script-compile/constants";
// 引擎 SDK 类型契约（与 monaco-setup 注入 extraLib 是同一份源）
import tveDts from "../../../framework/scripting/tve.d.ts?raw";
import {
  collectImportedNames,
  insideImportClause,
  localDeclaredNames,
  looksLikeCodeContext,
  relativeSpecifier,
  scriptTypeImportEdits,
  tveAutoImportEdits,
  type TextOp,
} from "./auto-import-core";

/** 导出名的补全种类（映射 Monaco CompletionItemKind） */
export type ExportKind = "class" | "interface" | "function" | "const" | "type" | "enum";

/** 模块导出项（tve 与用户脚本共用；isDefault 仅脚本 default 导出为 true） */
export interface ModuleExportInfo {
  name: string;
  kind: ExportKind;
  isDefault: boolean;
}

/** tve 导出项（附 JSDoc 作为建议文档） */
export interface TveExportInfo extends ModuleExportInfo {
  doc: string | null;
}

// ---------------------------------------------------------------------------
// 导出清单解析（AST 静态扫描，不执行代码）
// ---------------------------------------------------------------------------

/** 扫描一份 TS 源码的模块级导出（export 声明 + export { … } 列表） */
export function scriptExportsOf(ts: TsModule, source: string): ModuleExportInfo[] {
  const sf = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest, true);
  const byName = new Map<string, ModuleExportInfo>();
  const put = (info: ModuleExportInfo): void => {
    const prev = byName.get(info.name);
    // 同名多次导出（default 类 + 具名再导出）：default 优先（建议 default 导入形态）
    if (!prev || (info.isDefault && !prev.isDefault)) byName.set(info.name, info);
  };
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st)) {
      if (st.moduleSpecifier || !st.exportClause || !ts.isNamedExports(st.exportClause)) continue;
      for (const el of st.exportClause.elements) {
        put({
          name: el.name.text,
          kind: "const",
          isDefault: el.propertyName?.text === "default",
        });
      }
      continue;
    }
    const modifiers = ts.canHaveModifiers(st) ? ts.getModifiers(st) : undefined;
    if (!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const isDefault = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (ts.isVariableStatement(st)) {
      for (const decl of st.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) put({ name: decl.name.text, kind: "const", isDefault });
      }
      continue;
    }
    let info: ModuleExportInfo | null = null;
    if (ts.isClassDeclaration(st) && st.name) info = { name: st.name.text, kind: "class", isDefault };
    else if (ts.isFunctionDeclaration(st) && st.name)
      info = { name: st.name.text, kind: "function", isDefault };
    else if (ts.isInterfaceDeclaration(st))
      info = { name: st.name.text, kind: "interface", isDefault };
    else if (ts.isEnumDeclaration(st)) info = { name: st.name.text, kind: "enum", isDefault };
    else if (ts.isTypeAliasDeclaration(st)) info = { name: st.name.text, kind: "type", isDefault };
    if (info) put(info);
  }
  return [...byName.values()];
}

let tveExportsPromise: Promise<TveExportInfo[]> | null = null;

/** 解析 tve.d.ts 导出清单（含 JSDoc 文档；进程内只解析一次） */
export function tveExports(): Promise<TveExportInfo[]> {
  if (!tveExportsPromise) {
    tveExportsPromise = (async () => {
      const ts = await loadTs();
      const sf = ts.createSourceFile("tve.d.ts", tveDts, ts.ScriptTarget.Latest, true);
      const docs = new Map<string, string | null>();
      const list: TveExportInfo[] = [];
      for (const st of sf.statements) {
        if (ts.isExportDeclaration(st)) {
          if (st.moduleSpecifier || !st.exportClause || !ts.isNamedExports(st.exportClause)) continue;
          for (const el of st.exportClause.elements) {
            list.push({ name: el.name.text, kind: "const", isDefault: false, doc: null });
          }
          continue;
        }
        if (!ts.canHaveModifiers(st)) continue;
        const modifiers = ts.getModifiers(st);
        if (!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
        const push = (name: string | null, kind: ExportKind): void => {
          if (!name) return;
          const doc = jsdocOf(ts, st);
          docs.set(name, doc);
          list.push({ name, kind, isDefault: false, doc });
        };
        if (ts.isVariableStatement(st)) {
          for (const decl of st.declarationList.declarations) {
            if (ts.isIdentifier(decl.name)) push(decl.name.text, "const");
          }
        } else if (ts.isClassDeclaration(st)) push(st.name?.text ?? null, "class");
        else if (ts.isFunctionDeclaration(st)) push(st.name?.text ?? null, "function");
        else if (ts.isInterfaceDeclaration(st)) push(st.name.text, "interface");
        else if (ts.isEnumDeclaration(st)) push(st.name.text, "enum");
        else if (ts.isTypeAliasDeclaration(st)) push(st.name.text, "type");
      }
      return list;
    })();
  }
  return tveExportsPromise;
}

function jsdocOf(ts: TsModule, node: ts.Node): string | null {
  const parts: string[] = [];
  for (const j of ts.getJSDocCommentsAndTags(node)) {
    if (!ts.isJSDoc(j)) continue;
    const text = ts.getTextOfJSDocComment(j.comment);
    if (text) parts.push(text);
  }
  return parts.length ? parts.join("\n") : null;
}

// ---------------------------------------------------------------------------
// Monaco 补全提供器（typescript 语言；进程内只注册一次）
// ---------------------------------------------------------------------------

/** Monaco 模型 URI → 项目相对路径（file:///src/hp.ts → src/hp.ts；含中文解码） */
export function relOfModel(uri: MonacoApi.Uri): string {
  return decodeURIComponent(uri.path).replace(/^\//, "");
}

/** 脚本导出解析缓存（key = 源码文本；只留最近一份/模型，由 model 键控） */
const scriptExportsCache = new WeakMap<MonacoApi.editor.ITextModel, {
  source: string;
  exports: ModuleExportInfo[];
}>();

function modelExports(ts: TsModule, model: MonacoApi.editor.ITextModel): ModuleExportInfo[] {
  const source = model.getValue();
  const cached = scriptExportsCache.get(model);
  if (cached && cached.source === source) return cached.exports;
  const exports = scriptExportsOf(ts, source);
  scriptExportsCache.set(model, { source, exports });
  return exports;
}

let registered = false;

/** 注册类型自动导入补全（幂等；首次调用会预热 tve 导出解析） */
export function setupScriptIntellisense(monaco: MonacoNamespace): void {
  if (registered) return;
  registered = true;
  void tveExports();

  monaco.languages.registerCompletionItemProvider("typescript", {
    async provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      if (!word.word) return { suggestions: [] };
      const offset = model.getOffsetAt(position);
      const wordStart = offset - word.word.length;
      const source = model.getValue();
      const lineBefore = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: word.startColumn,
      });
      const charBefore = wordStart > 0 ? source[wordStart - 1] : "";
      if (
        charBefore === "." ||
        insideImportClause(source.slice(0, wordStart)) ||
        !looksLikeCodeContext(source, wordStart, lineBefore)
      ) {
        return { suggestions: [] };
      }
      const imported = collectImportedNames(source);
      const declared = localDeclaredNames(source);
      const prefix = word.word.toLowerCase();
      const match = (name: string): boolean =>
        name.toLowerCase().startsWith(prefix) && !imported.has(name) && !declared.has(name);

      const range = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      );
      const suggestions: MonacoApi.languages.CompletionItem[] = [];

      const tveList = await tveExports();
      for (const exp of tveList) {
        if (!match(exp.name)) continue;
        suggestions.push({
          label: exp.name,
          kind: completionKind(monaco, exp.kind),
          insertText: exp.name,
          sortText: `~${exp.name}`,
          detail: `自动导入 · "tve"`,
          documentation: exp.doc ? { value: exp.doc } : undefined,
          range,
          additionalTextEdits: opsToEdits(model, tveAutoImportEdits(source, exp.name)),
        });
      }

      // 其他脚本的导出（脚本模型由 model-sync 全量镜像；当前文件排除）
      const ts = await loadTs();
      const rel = relOfModel(model.uri);
      for (const m of monaco.editor.getModels()) {
        if (m === model || m.getLanguageId() !== "typescript") continue;
        const targetRel = relOfModel(m.uri);
        if (!targetRel.startsWith("src/") || !targetRel.endsWith(".ts")) continue;
        const specifier = relativeSpecifier(rel, targetRel);
        for (const exp of modelExports(ts, m)) {
          if (!match(exp.name)) continue;
          suggestions.push({
            label: exp.name,
            kind: completionKind(monaco, exp.kind),
            insertText: exp.name,
            sortText: `~${exp.name}`,
            detail: `自动导入 · ${specifier}`,
            documentation: {
              value: `脚本组件 \`${targetRel}\`\n\n以 type-only import 引入（编译期擦除，运行时脚本类全局可见）`,
            },
            range,
            additionalTextEdits: opsToEdits(
              model,
              scriptTypeImportEdits(source, exp.name, specifier, exp.isDefault),
            ),
          });
        }
      }
      return { suggestions };
    },
  });
}

function completionKind(
  monaco: MonacoNamespace,
  kind: ExportKind,
): MonacoApi.languages.CompletionItemKind {
  switch (kind) {
    case "class":
      return monaco.languages.CompletionItemKind.Class;
    case "interface":
      return monaco.languages.CompletionItemKind.Interface;
    case "function":
      return monaco.languages.CompletionItemKind.Function;
    case "enum":
      return monaco.languages.CompletionItemKind.Enum;
    case "type":
      return monaco.languages.CompletionItemKind.TypeParameter;
    default:
      return monaco.languages.CompletionItemKind.Variable;
  }
}

/** 文档偏移编辑 → Monaco 附加编辑（接受建议时与词替换一并应用） */
function opsToEdits(
  model: MonacoApi.editor.ITextModel,
  ops: TextOp[],
): MonacoApi.editor.ISingleEditOperation[] {
  return ops.map((op) => {
    const p1 = model.getPositionAt(op.start);
    const p2 = model.getPositionAt(op.end);
    return {
      range: {
        startLineNumber: p1.lineNumber,
        startColumn: p1.column,
        endLineNumber: p2.lineNumber,
        endColumn: p2.column,
      },
      text: op.text,
    };
  });
}
