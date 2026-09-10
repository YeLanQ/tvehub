// ---------------------------------------------------------------------------
// 单脚本编译（TS → JS，内存编译、产物不落盘）：
// - compileScript（对外导出）：transpileModule 转译（ES2020 ESM）+ tve 裸导入
//   说明符重写（paths.ts）+ 裸组件字段声明元数据注入（本文件 transformer）；
// - 组件字段 transformer：扫描默认导出类，把组件类型字段收集为
//   `static __tveComponentKeys`（详见下方分节说明）。
// 依赖 constants.ts（TsModule / loadTs）、paths.ts（tveImportFor /
// rewriteTveSpecifiers）、meta.ts（decoratorsOf / decoratorMatches，
// 用于跳过 @property 已登记的字段）。被 project.ts 的全量编译调用。
// ---------------------------------------------------------------------------

import type * as ts from "typescript";
import type { TsModule } from "./constants";
import { loadTs } from "./constants";
import { decoratorsOf, decoratorMatches } from "./meta";
import { rewriteTveSpecifiers, tveImportFor } from "./paths";

// ---------------------------------------------------------------------------
// 裸组件字段声明 → 运行时元数据（编译期 transformer 注入）
//
// 支持 `public anim!: AnimationClip;`（内置组件）与
// `follow!: CameraFollow;`（用户脚本组件，配合 `import type CameraFollow from
// "./CameraFollow"` 提供类型）这类不带 @property 的组件字段声明：TS 类型标注
// 编译后擦除，运行时无法感知，因此在转译前经自定义 transformer 扫描默认导出
// 类，把组件类型字段收集为 `static __tveComponentKeys = [["字段名","token"], ...]`
// 注入类体（内置组件 token 为组件类型键；脚本组件 token 为 "script:类名"）。
// 播放器脚本宿主实例化后据此 get-or-create：内置组件绑定门面，脚本组件按全局
// 脚本类注册表查找绑定（缺失则动态实例化并进入生命周期）。
// type-only import 编译期被擦除，不产生任何运行时模块依赖——脚本之间互相
// 引用组件类型无需真实 import（单一程序集式的引用体验）。
// ---------------------------------------------------------------------------

/** 组件字段声明的类型名 → 组件类型键（与 tve 导出的门面类名一致） */
const COMPONENT_TYPE_KEYS: Record<string, string> = {
  AnimationClip: "animationClip",
  SkeletalAnimation: "skeletalAnimation",
  RigidBody: "rigidBody",
  Collider: "collider",
  Light: "light",
  AudioSource: "audioSource",
};

/** 裸字段声明不作为组件引用处理的类型名（节点引用走 @property({ type: 节点类 })；
 *  tve 的接口/工具类型不是场景组件） */
const BARE_FIELD_DENYLIST = new Set([
  "Transform",
  "MeshNode",
  "LightNode",
  "CameraNode",
  "SkyboxNode",
  "ParticleSystemNode",
  "Entity",
  "Component",
  "Vec3",
  "math",
  "engine",
  "property",
  "nodeType",
]);

/** 类型节点里的标识符名（TypeReference 直接取名；联合取各成员名） */
function typeIdentifierNames(ts: TsModule, t: ts.TypeNode): string[] {
  const nameOf = (x: ts.TypeNode): string | null =>
    ts.isTypeReferenceNode(x) && ts.isIdentifier(x.typeName) ? x.typeName.text : null;
  if (ts.isUnionTypeNode(t)) {
    return t.types.map(nameOf).filter((n): n is string => !!n);
  }
  const n = nameOf(t);
  return n ? [n] : [];
}

/** 文件内 import 绑定的本地名集合（含 import type；字段类型名须被导入才登记） */
function collectImportedNames(ts: TsModule, sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const clause = st.importClause;
    if (clause.name) names.add(clause.name.text);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) names.add(el.name.text);
    }
  }
  return names;
}

/**
 * 字段类型 → 组件引用元数据 token：
 * - 内置组件类名（AnimationClip 等）→ 组件类型键；
 * - 其他被 import 的类型名（用户脚本类，经 import type 引入类型）→
 *   "script:类名"（运行期按全局脚本类注册表查找 get-or-create）；
 * - 未导入的类型 / 节点类型 / tve 工具类型 → null（不登记）。
 */
function componentTokenOfTypeNode(
  ts: TsModule,
  t: ts.TypeNode,
  importedNames: Set<string>,
): string | null {
  for (const n of typeIdentifierNames(ts, t)) {
    if (COMPONENT_TYPE_KEYS[n]) return COMPONENT_TYPE_KEYS[n];
    if (importedNames.has(n) && !BARE_FIELD_DENYLIST.has(n)) {
      return `script:${n}`;
    }
  }
  return null;
}

/** 是否默认导出的类声明（与 parseScriptClassMeta 的目标类一致） */
function isDefaultExportClass(ts: TsModule, node: ts.Node): node is ts.ClassDeclaration {
  return (
    ts.isClassDeclaration(node) &&
    !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
  );
}

/** 注入静态成员：static __tveComponentKeys = [[name, typeKey], ...] */
function injectComponentKeys(
  ts: TsModule,
  factory: ts.NodeFactory,
  cls: ts.ClassDeclaration,
  pairs: [string, string][],
): ts.ClassDeclaration {
  const initializer = factory.createArrayLiteralExpression(
    pairs.map(([key, typeKey]) =>
      factory.createArrayLiteralExpression([
        factory.createStringLiteral(key),
        factory.createStringLiteral(typeKey),
      ]),
    ),
  );
  const member = factory.createPropertyDeclaration(
    [factory.createModifier(ts.SyntaxKind.StaticKeyword)],
    "__tveComponentKeys",
    undefined,
    undefined,
    initializer,
  );
  return factory.updateClassDeclaration(
    cls,
    cls.modifiers,
    cls.name,
    cls.typeParameters,
    cls.heritageClauses,
    [...cls.members, member],
  );
}

/** 裸组件字段声明收集/注入 transformer（默认导出类；已有该静态成员则跳过） */
function componentFieldTransformer(ts: TsModule): ts.TransformerFactory<ts.SourceFile> {
  return (context) => (sf: ts.SourceFile) => {
    const importedNames = collectImportedNames(ts, sf);
    const visitor = (node: ts.Node): ts.Node => {
      if (isDefaultExportClass(ts, node)) {
        const pairs: [string, string][] = [];
        for (const m of node.members) {
          if (!ts.isPropertyDeclaration(m) || !m.type) continue;
          // 静态成员与 @property 装饰器字段（装饰器路径自行登记）不参与
          if (m.modifiers?.some((k) => k.kind === ts.SyntaxKind.StaticKeyword)) continue;
          if (decoratorsOf(ts, m).some((d) => decoratorMatches(ts, d, "property"))) continue;
          const token = componentTokenOfTypeNode(ts, m.type, importedNames);
          if (!token) continue;
          const name = ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) ? m.name.text : null;
          if (name) pairs.push([name, token]);
        }
        if (!pairs.length) return node;
        const hasExisting = node.members.some(
          (m) =>
            ts.isPropertyDeclaration(m) &&
            !!m.modifiers?.some((k) => k.kind === ts.SyntaxKind.StaticKeyword) &&
            (ts.isIdentifier(m.name) ? m.name.text : "") === "__tveComponentKeys",
        );
        return hasExisting ? node : injectComponentKeys(ts, context.factory, node, pairs);
      }
      return ts.visitEachChild(node, visitor, context);
    };
    return ts.visitNode(sf, visitor) as ts.SourceFile;
  };
}

export interface CompiledScript {
  /** 编译产物（失败为空串） */
  js: string;
  /** 首条诊断信息（语法错误；类型诊断由 Monaco 语言服务在编辑器内给出） */
  error: string | null;
}

/** 编译单个脚本：转译 + tve 说明符重写 + 裸组件字段声明元数据注入 */
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
