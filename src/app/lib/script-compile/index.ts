// ---------------------------------------------------------------------------
// 用户脚本编译库（TS → JS，内存编译、产物不落盘）：
// - compileScript：transpileModule 转译（ES2020 ESM），并把 "tve" 裸导入
//   说明符按脚本目录重写为相对 engine/core/tve.mjs 的路径（AST 级精确替换）——
//   编译产物在文件模式按相对路径解析、在单页模式由构建管线重写为 tve: 裸说明符，
//   两种产物形态均无需 import map；
// - parsePropsSchema：TS AST 解析脚本默认导出类的 `static props = {...}` 声明，
//   供检查器渲染属性编辑控件（不执行用户代码）；
// - loadProjectScripts / compileProjectScripts：预览与构建导出前的全量收集与编译，
//   产物以 { "src/x.js": jsText } 注入导出 files（Rust 端按运行时代码处理）。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 目录式模块入口（src/app/lib/script-compile/）：按职责拆分为
// constants.ts（共享常量与公共类型）、paths.ts（路径与 import 重写）、
// compile.ts（单脚本编译）、props.ts（props schema 解析）、meta.ts（装饰器与
// 类元数据）、project.ts（项目脚本收集与全量编译）。
// 本文件只做显式命名 re-export（与拆分前 script-compile.ts 的导出集合逐一对应，
// 不含 export *），因此调用方 `import { … } from "../lib/script-compile"` 无需改动。
// ---------------------------------------------------------------------------

// --- 共享常量与公共类型（constants.ts） ---
export type { ScriptPropType, ScriptPropDef } from "./constants";

// --- 路径与 import 重写（paths.ts） ---
export { scriptJsPath, tveImportFor } from "./paths";

// --- 单脚本编译（compile.ts） ---
export type { CompiledScript } from "./compile";
export { compileScript } from "./compile";

// --- props schema 解析（props.ts） ---
export { parsePropsSchema } from "./props";

// --- 装饰器与类元数据（meta.ts） ---
export type { ScriptNodeKind, ScriptNodeType, ScriptClassMeta } from "./meta";
export { parseScriptClassMeta } from "./meta";

// --- 项目脚本收集与全量编译（project.ts） ---
export type { ProjectScript, ProjectScriptsCompileResult } from "./project";
export { isScriptSource, ensureEntryScript, loadProjectScripts, compileProjectScripts } from "./project";
