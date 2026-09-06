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

/** 脚本属性类型（与 tve.d.ts PropType 一致；检查器按此渲染控件；
 *  entity = 场景节点引用，value 为节点 id，default ''，filter 限定可选节点类型） */
export type ScriptPropType = "number" | "string" | "boolean" | "color" | "vec3" | "entity";

export interface ScriptPropDef {
  key: string;
  type: ScriptPropType;
  default: number | string | boolean | { x: number; y: number; z: number };
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  /** entity 专用：允许引用的节点 typeKey 白名单（空数组 = 任意节点） */
  filter?: string[];
}

/** 基本类型字面量（entity 节点引用不用字符串书写，经 @property({ type: 节点类 }) 识别） */
const PROP_TYPES = ["number", "string", "boolean", "color", "vec3"];

/**
 * @property({ type: 节点类 }) 的节点类型 token 名 → 允许的编辑器节点 typeKey
 * （null = 任意场景节点）。与 tve.mjs 的节点类型类对应（大小写别名同义）。
 */
const NODE_REF_TYPE_KINDS: Record<string, string[] | null> = {
  Entity: null,
  Transform: null,
  transform: null,
  MeshNode: ["meshNode"],
  meshNode: ["meshNode"],
  LightNode: [
    "lightNode",
    "pointLightNode",
    "directionalLightNode",
    "ambientLightNode",
    "spotLightNode",
  ],
  lightNode: [
    "lightNode",
    "pointLightNode",
    "directionalLightNode",
    "ambientLightNode",
    "spotLightNode",
  ],
  CameraNode: ["cameraNode"],
  cameraNode: ["cameraNode"],
  SkyboxNode: ["skyboxNode"],
  skyboxNode: ["skyboxNode"],
};

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
      // 装饰器（@property / @nodeType）：TS 实验性装饰器 → 运行时 __decorate
      experimentalDecorators: true,
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
// 脚本类元数据解析（节点类型/属性声明）。支持两种写法：
// - 装饰器（推荐，参考 Cocos Creator @property / @nodeType）：字段用 @property
//   标注为可编辑属性（类型/默认值由字段初值与选项推断）；类用 @nodeType 声明
//   为可创建节点类型；
// - legacy 静态声明：`static props = {...}` 与 `static nodeType = {...}`（兼容保留）。
// 全部为 AST 静态解析，不执行用户代码；编辑器据此渲染检查器控件 / 提供节点入口。
// ---------------------------------------------------------------------------

/** 脚本类可声明的节点类型基础（对应引擎节点类型键；缺省 group = node 基类） */
export type ScriptNodeKind = "node" | "meshNode" | "cameraNode" | "lightNode" | "skyboxNode";

export interface ScriptNodeType {
  /** 基础节点类型（缺省 "node"=空组；运行时按此创建对应节点） */
  kind: ScriptNodeKind;
  /** 创建入口显示名（缺省用脚本类名） */
  label: string;
}

/** 脚本类的静态声明元数据（AST 解析，不执行用户代码） */
export interface ScriptClassMeta {
  /** 属性声明（检查器控件 schema）；无声明为 null */
  props: ScriptPropDef[] | null;
  /** 节点类型声明；未声明为 null（= 普通脚本组件） */
  nodeType: ScriptNodeType | null;
}

const NODE_KINDS: ScriptNodeKind[] = ["node", "meshNode", "cameraNode", "lightNode", "skyboxNode"];

/** 解析脚本类 `static nodeType = { kind, label }` 声明（非法/未声明返回 null） */
function parseNodeType(ts: TsModule, member: ts.PropertyDeclaration): ScriptNodeType | null {
  if (!member.initializer || !ts.isObjectLiteralExpression(member.initializer)) return null;
  let kind: ScriptNodeType["kind"] = "node";
  let label: string | undefined;
  for (const p of member.initializer.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const name = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
    if (name === "kind") {
      const v = literalValue(ts, p.initializer);
      if (typeof v === "string" && NODE_KINDS.includes(v as ScriptNodeKind)) {
        kind = v as ScriptNodeKind;
      }
    } else if (name === "label") {
      const v = literalValue(ts, p.initializer);
      if (typeof v === "string" && v.trim()) label = v.trim();
    }
  }
  return { kind, label: label || "Node" };
}

// ---------------------------------------------------------------------------
// 装饰器解析辅助
// ---------------------------------------------------------------------------

/** 取节点上的装饰器列表（TS 5 经 getDecorators；兼容旧字段） */
function decoratorsOf(ts: TsModule, node: ts.Node): readonly ts.Decorator[] {
  const via =
    typeof ts.getDecorators === "function" && ts.canHaveDecorators(node)
      ? ts.getDecorators(node)
      : undefined;
  if (via) return via;
  const legacy = (node as { decorators?: readonly ts.Decorator[] }).decorators;
  return legacy ?? [];
}

/** 装饰器是否指向 name（标识符 或 调用表达式；含命名空间访问 tve.property 尾部名） */
function decoratorMatches(ts: TsModule, dec: ts.Decorator, name: string): boolean {
  const e = dec.expression;
  if (ts.isIdentifier(e)) return e.text === name;
  if (ts.isCallExpression(e)) {
    const callee = e.expression;
    if (ts.isIdentifier(callee)) return callee.text === name;
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text === name;
  }
  return false;
}

/** 取装饰器实参对象字面量（无实参/裸装饰器返回空对象；非对象实参忽略） */
function decoratorArgs(ts: TsModule, dec: ts.Decorator): ts.ObjectLiteralExpression | null {
  const e = dec.expression;
  if (!ts.isCallExpression(e) || e.arguments.length === 0) return null;
  const a0 = e.arguments[0];
  return ts.isObjectLiteralExpression(a0) ? a0 : null;
}

interface DecoratedOptions {
  /** 该名字的装饰器是否存在（含裸 @property） */
  present: boolean;
  type?: ScriptPropType;
  /** 节点类型 token 的过滤键（undefined = 非节点引用；null = 任意节点） */
  nodeRef?: string[] | null;
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  kind?: ScriptNodeKind;
}

/** 从表达式中取名称（标识符 / 属性访问尾部，如 meshNode、cc.MeshNode） */
function exprTailName(ts: TsModule, expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

/** 解析装饰器选项对象字面量（type/label/min/max/step/kind 的字符串与数值项） */
function readDecoratedOptions(ts: TsModule, obj: ts.ObjectLiteralExpression | null): DecoratedOptions {
  const out: DecoratedOptions = { present: true };
  if (!obj) return out;
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
    if (!key) continue;
    if (key === "type") {
      const lv = literalValue(ts, p.initializer);
      if (typeof lv === "string" && PROP_TYPES.includes(lv as ScriptPropType)) {
        out.type = lv as ScriptPropType;
        continue;
      }
      // type: 节点类型类（MeshNode / meshNode …）→ 节点引用（entity）
      const name = exprTailName(ts, p.initializer);
      if (name && Object.prototype.hasOwnProperty.call(NODE_REF_TYPE_KINDS, name)) {
        out.nodeRef = NODE_REF_TYPE_KINDS[name] ?? null;
      }
    } else if (key === "label" || key === "tooltip") {
      const v = literalValue(ts, p.initializer);
      if (typeof v === "string" && v.trim()) out.label = v.trim();
    } else if (key === "kind") {
      const v = literalValue(ts, p.initializer);
      if (typeof v === "string" && NODE_KINDS.includes(v as ScriptNodeKind)) {
        out.kind = v as ScriptNodeKind;
      }
    } else if (key === "min" || key === "max" || key === "step") {
      const v = literalValue(ts, p.initializer);
      if (typeof v === "number") out[key] = v;
    }
  }
  return out;
}

/** 在节点装饰器里找 name 的调用/裸引用：返回选项（含 present 标记），未命中 present=false */
function findDecoratorOptions(
  ts: TsModule,
  node: ts.Node,
  name: string,
): DecoratedOptions & { present: boolean } {
  for (const dec of decoratorsOf(ts, node)) {
    if (!decoratorMatches(ts, dec, name)) continue;
    return readDecoratedOptions(ts, decoratorArgs(ts, dec));
  }
  return { present: false };
}

/** 十六进制颜色字符串判定（#rgb / #rgba / #rrggbb / #rrggbbaa） */
const HEX_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** 对象字面量是否为 {x,y,z} 数值向量 */
function isVec3Literal(ts: TsModule, init: ts.Expression): boolean {
  if (!ts.isObjectLiteralExpression(init)) return false;
  const nums: Record<string, boolean> = {};
  for (const p of init.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
    if (key === "x" || key === "y" || key === "z") {
      const v = literalValue(ts, p.initializer);
      nums[key] = typeof v === "number";
    }
  }
  return nums.x === true && nums.y === true && nums.z === true;
}

/** 由字段初值推断值类型（无初值/无法推断返回 null） */
function inferFieldType(ts: TsModule, init: ts.Expression | undefined, optType?: ScriptPropType): ScriptPropType | null {
  if (optType) return optType;
  if (!init) return null;
  const lv = literalValue(ts, init);
  if (typeof lv === "number") return "number";
  if (typeof lv === "boolean") return "boolean";
  if (ts.isStringLiteral(init)) {
    return HEX_RE.test(init.text) ? "color" : "string";
  }
  if (isVec3Literal(ts, init)) return "vec3";
  return null;
}

/** 解析 @property 装饰的字段成员（类型 + 默认值 = 字段初值 + 选项） */
function parseDecoratedProps(ts: TsModule, cls: ts.ClassDeclaration): ScriptPropDef[] | null {
  const defs: ScriptPropDef[] = [];
  for (const m of cls.members) {
    if (!ts.isPropertyDeclaration(m)) continue;
    // 静态成员不作组件属性
    if (m.modifiers?.some((k) => k.kind === ts.SyntaxKind.StaticKeyword)) continue;
    const name = ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) ? m.name.text : null;
    if (!name) continue;
    const opts = findDecoratorOptions(ts, m, "property");
    if (!opts.present) continue;

    // 场景节点引用：@property({ type: MeshNode | meshNode | … }) → entity
    if (opts.nodeRef !== undefined) {
      defs.push({
        key: name,
        type: "entity",
        default: "",
        label: opts.label,
        filter: opts.nodeRef ? [...opts.nodeRef] : [],
      });
      continue;
    }

    if (!m.initializer) continue; // 无初值无法提供默认值
    const type = inferFieldType(ts, m.initializer, opts.type);
    if (!type) continue;
    let def: ScriptPropDef["default"] | null = null;
    if (type === "vec3") {
      def = vec3Value(ts, m.initializer);
    } else {
      const v = literalValue(ts, m.initializer);
      if (type === "string" || type === "color") def = typeof v === "string" ? v : null;
      else def = v;
    }
    if (def === null) continue;
    defs.push({ key: name, type, default: def, label: opts.label, min: opts.min, max: opts.max, step: opts.step });
  }
  return defs.length ? defs : null;
}

/**
 * 解析脚本类的属性声明与节点类型声明（装饰器优先；无则回退 legacy 静态写法）。
 * @returns props 为 null 表示未声明（非空数组表示无属性）；nodeType 未声明返回 null。
 */
export async function parseScriptClassMeta(source: string): Promise<ScriptClassMeta> {
  const ts = await loadTs();
  const sf = ts.createSourceFile("script.ts", source, ts.ScriptTarget.Latest, true);

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
  if (!cls) return { props: null, nodeType: null };

  const staticMember = (key: string): ts.PropertyDeclaration | undefined =>
    cls.members.find(
      (m): m is ts.PropertyDeclaration =>
        ts.isPropertyDeclaration(m) &&
        !!m.modifiers?.some((k) => k.kind === ts.SyntaxKind.StaticKeyword) &&
        (ts.isIdentifier(m.name) ? m.name.text : "") === key,
    );

  // 属性声明：@property 字段装饰器优先，其次 legacy static props
  const decoratedProps = parseDecoratedProps(ts, cls);
  let props: ScriptPropDef[] | null = null;
  if (decoratedProps) {
    props = decoratedProps;
  } else {
    const propsMember = staticMember("props");
    if (propsMember?.initializer && ts.isObjectLiteralExpression(propsMember.initializer)) {
      const defs: ScriptPropDef[] = [];
      for (const p of propsMember.initializer.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
        if (!key) continue;
        const def = parsePropDef(ts, p.initializer, key);
        if (def) defs.push(def);
      }
      props = defs;
    }
  }

  // 节点类型声明：@nodeType 类装饰器优先，其次 legacy static nodeType
  let nodeType: ScriptNodeType | null = null;
  const decNT = findDecoratorOptions(ts, cls, "nodeType");
  if (decNT.present) {
    nodeType = { kind: decNT.kind ?? "node", label: decNT.label ?? "Node" };
  } else {
    const nodeTypeMember = staticMember("nodeType");
    if (nodeTypeMember) nodeType = parseNodeType(ts, nodeTypeMember);
  }

  return { props, nodeType };
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
