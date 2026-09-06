// ---------------------------------------------------------------------------
// 用户脚本编译库（TS → JS，内存编译、产物不落盘）：
// - compileScript：transpileModule 转译（ES2020 ESM），并把 "tve" 裸导入
//   说明符按脚本目录重写为相对 libs/tve.mjs 的路径（AST 级精确替换）——
//   编译产物在文件模式按相对路径解析、在单页模式由构建管线重写为 tve: 裸说明符，
//   两种产物形态均无需 import map；
// - parsePropsSchema：TS AST 解析脚本默认导出类的 `static props = {...}` 声明，
//   供检查器渲染属性编辑控件（不执行用户代码）；
// - loadProjectScripts / compileProjectScripts：预览与构建导出前的全量收集与编译，
//   产物以 { "src/x.js": jsText } 注入导出 files（Rust 端按运行时代码处理）。
// ---------------------------------------------------------------------------

import type * as ts from "typescript";
import { api } from "../../lib/api";
import { logStore } from "../stores/log";

/** typescript 编译器（懒加载：首次编译/解析时引入，约 7MB 惰性 chunk；
 *  类型经上方 import type 静态引入，编译期擦除不影响懒加载） */
type TsModule = typeof ts;
let tsPromise: Promise<TsModule> | null = null;

async function loadTs(): Promise<TsModule> {
  if (!tsPromise) tsPromise = import("typescript");
  return tsPromise;
}

/** 脚本属性类型（与 tve.d.ts PropType 一致；检查器按此渲染控件） */
export type ScriptPropType = "number" | "string" | "boolean" | "color" | "vec3";

export interface ScriptPropDef {
  key: string;
  type: ScriptPropType;
  default: number | string | boolean | { x: number; y: number; z: number };
  label?: string;
  min?: number;
  max?: number;
  step?: number;
}

const PROP_TYPES: ScriptPropType[] = ["number", "string", "boolean", "color", "vec3"];

/** 源路径（src/**.ts）→ 编译产物路径（src/**.js） */
export function scriptJsPath(srcRel: string): string {
  return srcRel.replace(/\.tsx?$/, ".js");
}

/**
 * 计算从脚本目录指向运行时模块（libs/tve.mjs）的相对导入说明符。
 * @param scriptRel 脚本源路径（如 "src/main.ts"、"src/ui/button.ts"）
 */
export function tveImportFor(scriptRel: string): string {
  const dir = scriptRel.includes("/") ? scriptRel.slice(0, scriptRel.lastIndexOf("/")) : "";
  const fromParts = dir ? dir.split("/") : [];
  const toParts = "libs/tve.mjs".split("/");
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
function rewriteTveSpecifiers(ts: TsModule, source: string, replacement: string): string {
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

export interface CompiledScript {
  /** 编译产物（失败为空串） */
  js: string;
  /** 首条诊断信息（语法错误；类型诊断由 Monaco 语言服务在编辑器内给出） */
  error: string | null;
}

/** 编译单个脚本：转译 + tve 说明符重写 */
export async function compileScript(source: string, scriptRel: string): Promise<CompiledScript> {
  const ts = await loadTs();
  const preprocessed = rewriteTveSpecifiers(ts, source, tveImportFor(scriptRel));
  const out = ts.transpileModule(preprocessed, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      strict: true,
      isolatedModules: true,
    },
    reportDiagnostics: true,
  });
  const first = (out.diagnostics ?? [])[0];
  if (first) {
    const msg = ts.flattenDiagnosticMessageText(first.messageText, " ");
    return { js: "", error: msg };
  }
  return { js: out.outputText, error: null };
}

// ---------------------------------------------------------------------------
// props 声明解析（检查器控件 schema；不执行用户代码）
// ---------------------------------------------------------------------------

function literalValue(ts: TsModule, expr: ts.Expression): number | string | boolean | null {
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (ts.isStringLiteral(expr)) return expr.text;
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken) {
    const inner = literalValue(ts, expr.operand);
    return typeof inner === "number" ? -inner : null;
  }
  return null;
}

function vec3Value(ts: TsModule, expr: ts.Expression): { x: number; y: number; z: number } | null {
  if (!ts.isObjectLiteralExpression(expr)) return null;
  const v: { x?: number; y?: number; z?: number } = {};
  for (const p of expr.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const name = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
    if (name !== "x" && name !== "y" && name !== "z") continue;
    const val = literalValue(ts, p.initializer);
    if (typeof val === "number") v[name] = val;
  }
  if (typeof v.x !== "number" || typeof v.y !== "number" || typeof v.z !== "number") return null;
  return { x: v.x, y: v.y, z: v.z };
}

/** 单个属性定义对象字面量 → ScriptPropDef（非法定义跳过返回 null） */
function parsePropDef(ts: TsModule, expr: ts.Expression, key: string): ScriptPropDef | null {
  if (!ts.isObjectLiteralExpression(expr)) return null;
  let type: ScriptPropType | null = null;
  let def: ScriptPropDef["default"] | null = null;
  let label: string | undefined;
  let min: number | undefined;
  let max: number | undefined;
  let step: number | undefined;
  let hasDefault = false;

  for (const p of expr.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const name = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
    switch (name) {
      case "type": {
        if (ts.isStringLiteral(p.initializer) && PROP_TYPES.includes(p.initializer.text as ScriptPropType)) {
          type = p.initializer.text as ScriptPropType;
        }
        break;
      }
      case "default": {
        if (type === "vec3") {
          const v = vec3Value(ts, p.initializer);
          if (v) {
            def = v;
            hasDefault = true;
          }
        } else {
          const v = literalValue(ts, p.initializer);
          if (v !== null) {
            def = v;
            hasDefault = true;
          }
        }
        break;
      }
      case "label": {
        if (ts.isStringLiteral(p.initializer) && p.initializer.text) label = p.initializer.text;
        break;
      }
      case "min":
      case "max":
      case "step": {
        const v = literalValue(ts, p.initializer);
        if (typeof v === "number") {
          if (name === "min") min = v;
          else if (name === "max") max = v;
          else step = v;
        }
        break;
      }
    }
  }
  if (!type || !hasDefault || def === null) return null;
  return { key, type, default: def, label, min, max, step };
}

/**
 * 解析脚本默认导出类的 `static props = {...}` 属性声明。
 * @returns 属性定义列表；无默认导出类或未声明 props 返回 null（检查器据此区分
 *          "无属性" 与 "解析失败"）。
 */
export async function parsePropsSchema(source: string): Promise<ScriptPropDef[] | null> {
  const ts = await loadTs();
  const sf = ts.createSourceFile("script.ts", source, ts.ScriptTarget.Latest, true);

  // 默认导出类（export default class X ...）
  let cls: ts.ClassDeclaration | null = null;
  for (const st of sf.statements) {
    if (
      ts.isClassDeclaration(st) &&
      st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      cls = st;
      break;
    }
  }
  if (!cls) return null;

  // static props = {...}
  const member = cls.members.find(
    (m): m is ts.PropertyDeclaration =>
      ts.isPropertyDeclaration(m) &&
      !!m.modifiers?.some((k) => k.kind === ts.SyntaxKind.StaticKeyword) &&
      (ts.isIdentifier(m.name) ? m.name.text : "") === "props" &&
      !!m.initializer &&
      ts.isObjectLiteralExpression(m.initializer),
  );
  if (!member || !member.initializer || !ts.isObjectLiteralExpression(member.initializer)) {
    return null;
  }

  const defs: ScriptPropDef[] = [];
  for (const p of member.initializer.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
    if (!key) continue;
    const def = parsePropDef(ts, p.initializer, key);
    if (def) defs.push(def);
  }
  return defs;
}

// ---------------------------------------------------------------------------
// 项目脚本收集与全量编译（预览 / 构建导出前调用）
// ---------------------------------------------------------------------------

export interface ProjectScript {
  /** 源路径（src/**.ts） */
  rel: string;
  source: string;
}

/** 是否为用户脚本源文件（src/ 下的 .ts；tve.d.ts 等声明文件排除） */
export function isScriptSource(rel: string): boolean {
  return (
    rel.startsWith("src/") &&
    (rel.endsWith(".ts") || rel.endsWith(".tsx")) &&
    !rel.endsWith(".d.ts")
  );
}

/** 读取项目全部脚本源文件 */
export async function loadProjectScripts(root: string): Promise<ProjectScript[]> {
  const entries = await api.scanAssets(root);
  const rels = entries.map((e) => e.path).filter(isScriptSource);
  const out: ProjectScript[] = [];
  for (const rel of rels) {
    try {
      const source = await api.readText(root, rel);
      if (source != null) out.push({ rel, source });
    } catch (e) {
      logStore.log("error", `读取脚本失败 ${rel}: ${e}`, "script");
    }
  }
  return out;
}

export interface ProjectScriptsCompileResult {
  /** 编译产物（key = src/**.js，随导出 files 传给后端） */
  files: Record<string, string>;
  /** 失败清单（rel → 错误信息） */
  errors: Record<string, string>;
}

/** 全量编译项目脚本（单个失败跳过并记录，不阻断导出） */
export async function compileProjectScripts(
  scripts: ProjectScript[],
): Promise<ProjectScriptsCompileResult> {
  const files: Record<string, string> = {};
  const errors: Record<string, string> = {};
  for (const s of scripts) {
    const r = await compileScript(s.source, s.rel);
    if (r.error || !r.js) {
      errors[s.rel] = r.error ?? "空产物";
      continue;
    }
    files[scriptJsPath(s.rel)] = r.js;
  }
  return { files, errors };
}
