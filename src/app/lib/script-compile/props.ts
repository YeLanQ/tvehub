// ---------------------------------------------------------------------------
// 属性声明（props）的语法树解析模块：对外导出 parsePropsSchema，并向 meta.ts
// 共享字段级解析辅助：
// - parsePropsSchema：解析默认导出类 `static props = {...}` 的 legacy 静态写法，
//   返回属性定义列表；
// - literalValue / vec3Value / parsePropDef（模块内共享，meta.ts 调用）：字面量
//   取值、{x,y,z} 向量取值、单个属性定义对象 → ScriptPropDef 的解析；
//   装饰器路径（meta.ts）复用同一套字段级解析规则，保证两种写法结果一致。
// 依赖 constants.ts（公共类型、PROP_TYPES 常量表、loadTs 懒加载器）。
// ---------------------------------------------------------------------------

import type * as ts from "typescript";
import type { ScriptPropDef, ScriptPropType, TsModule } from "./constants";
import { PROP_TYPES, loadTs } from "./constants";

// ---------------------------------------------------------------------------
// props 声明解析（检查器控件 schema；不执行用户代码）
// ---------------------------------------------------------------------------

/** 字面量取值（数字/字符串/布尔/负数前缀；非字面量返回 null）
 *  （模块内共享：meta.ts 的装饰器解析复用） */
export function literalValue(ts: TsModule, expr: ts.Expression): number | string | boolean | null {
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

/** 对象字面量 → {x,y,z} 数值向量（三轴齐全才算命中，否则 null）
 *  （模块内共享：meta.ts 的字段默认值解析复用） */
export function vec3Value(ts: TsModule, expr: ts.Expression): { x: number; y: number; z: number } | null {
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
// 模块内共享：meta.ts 的 legacy static props 解析复用
export function parsePropDef(ts: TsModule, expr: ts.Expression, key: string): ScriptPropDef | null {
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
