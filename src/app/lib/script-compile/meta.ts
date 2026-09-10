// ---------------------------------------------------------------------------
// 脚本类元数据解析（装饰器与 legacy 静态声明）：
// - parseScriptClassMeta（对外导出）：解析默认导出类的属性声明与节点类型声明；
// - 节点类型：ScriptNodeKind / ScriptNodeType / NODE_KINDS / parseNodeType
//   （legacy `static nodeType = {...}`）；
// - 装饰器辅助：decoratorsOf / decoratorMatches / decoratorArgs /
//   readDecoratedOptions / findDecoratorOptions（@property / @nodeType 求值），
//   其中 decoratorsOf / decoratorMatches 为模块内共享（compile.ts 的裸组件字段
//   transformer 用它跳过已由 @property 登记的字段）；
// - 字段推断：exprTailName / HEX_RE / isVec3Literal / inferFieldType /
//   parseDecoratedProps（字段初值 + 装饰器选项 → ScriptPropDef）。
// 依赖 constants.ts（公共类型、NODE_REF_TYPE_KINDS 常量表、loadTs）与 props.ts
// （literalValue / vec3Value / parsePropDef，两种声明写法共用同一套字段解析）。
// ---------------------------------------------------------------------------

import type * as ts from "typescript";
import type { ScriptPropDef, ScriptPropType, TsModule } from "./constants";
import { NODE_REF_TYPE_KINDS, PROP_TYPES, loadTs } from "./constants";
import { literalValue, parsePropDef, vec3Value } from "./props";

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
// 模块内共享：compile.ts 的裸组件字段 transformer 亦调用
export function decoratorsOf(ts: TsModule, node: ts.Node): readonly ts.Decorator[] {
  const via =
    typeof ts.getDecorators === "function" && ts.canHaveDecorators(node)
      ? ts.getDecorators(node)
      : undefined;
  if (via) return via;
  const legacy = (node as { decorators?: readonly ts.Decorator[] }).decorators;
  return legacy ?? [];
}

/** 装饰器是否指向 name（标识符 或 调用表达式；含命名空间访问 tve.property 尾部名） */
// 模块内共享：compile.ts 的裸组件字段 transformer 亦调用
export function decoratorMatches(ts: TsModule, dec: ts.Decorator, name: string): boolean {
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
