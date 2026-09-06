// ---------------------------------------------------------------------------
// Monaco 接线（脚本编辑器专用）：
// - 惰性加载（进入脚本模式才引入 editor.api / editor.all / TS 语言贡献与 worker）；
// - worker：editor.worker + typescript ts.worker（`?worker` 由 Vite 打包为 ESM Worker）；
// - TS 语言服务：compilerOptions 与编译管线一致（ES2020 / ESNext / strict），
//   tve.d.ts 以 node_modules/tve/index.d.ts 形式注入 extraLib —— 裸说明符
//   `import ... from "tve"` 即获得引擎 SDK 的智能提示与类型检查。
// ---------------------------------------------------------------------------

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
// 引擎 SDK 类型契约（与 public/web-preview/libs/tve.mjs 镜像同步）
import tveDts from "../../../framework/scripting/tve.d.ts?raw";

export type MonacoNamespace = typeof MonacoApi;

let monacoPromise: Promise<MonacoNamespace> | null = null;

/** 懒加载并配置 Monaco（进程内只执行一次） */
export function loadMonaco(): Promise<MonacoNamespace> {
  if (monacoPromise) return monacoPromise;
  monacoPromise = (async () => {
    const monaco = await import("monaco-editor/esm/vs/editor/editor.api");
    // 编辑器完整特性（查找/折叠/多光标…；不含其他语言）+ TS 语言贡献
    await import("monaco-editor/esm/vs/editor/editor.all");
    await import("monaco-editor/esm/vs/language/typescript/monaco.contribution");
    const [{ default: EditorWorker }, { default: TsWorker }] = await Promise.all([
      import("monaco-editor/esm/vs/editor/editor.worker?worker"),
      import("monaco-editor/esm/vs/language/typescript/ts.worker?worker"),
    ]);
    self.MonacoEnvironment = {
      getWorker(_workerId, label) {
        return label === "typescript" || label === "javascript"
          ? new TsWorker()
          : new EditorWorker();
      },
    };

    const ts = monaco.languages.typescript;
    if (ts) {
      ts.typescriptDefaults.setCompilerOptions({
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        strict: true,
        allowNonTsExtensions: true,
        noEmit: true,
        lib: ["es2020", "dom"],
      });
      ts.typescriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false,
      });
      // 引擎 SDK 类型：解析裸说明符 "tve"（node_modules 查找路径）
      ts.typescriptDefaults.addExtraLib(tveDts, "file:///node_modules/tve/index.d.ts");
    }
    return monaco;
  })();
  return monacoPromise;
}

/** 脚本源路径 → Monaco 模型 URI（file:///src/**.ts） */
export function scriptModelUri(monaco: MonacoNamespace, rel: string) {
  return monaco.Uri.parse("file:///" + rel);
}

/** 取或建脚本模型（同一脚本恒返回同一模型，随编辑器实例存活） */
export function ensureScriptModel(
  monaco: MonacoNamespace,
  rel: string,
  source: string,
): MonacoApi.editor.ITextModel {
  const uri = scriptModelUri(monaco, rel);
  let model = monaco.editor.getModel(uri);
  if (!model) {
    model = monaco.editor.createModel(source, "typescript", uri);
  }
  return model;
}
