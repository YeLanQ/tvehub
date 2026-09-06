// ---------------------------------------------------------------------------
// Monaco 接线（脚本编辑器专用，目标 = 还原 VS Code 的 TS 编辑体验）：
// - 编辑器核心采用 monaco-editor 的 editor.main 聚合入口：与 VS Code 同源的
//   全部功能模块随其副作用注册 —— 命令面板(F1/Ctrl+Shift+P)、查找替换、
//   TS 定义跳转(F12)/符号(Go to Symbol)/重命名(F2)/快速修复、多光标、
//   括号配对着色等快捷键即开即用；typescript 语言（Monarch 语法着色 +
//   TS 语言服务）也由 editor.main 加载；
// - 惰性加载（进入脚本模式才引入，打包为独立 chunk）；
// - worker：editor.worker + typescript ts.worker（`?worker` 由 Vite 打包为 ESM Worker）；
// - TS 语言服务 compilerOptions 与编译管线一致（ES2020 / ESNext / strict），
//   tve.d.ts 以 node_modules/tve/index.d.ts 形式注入 extraLib —— 裸说明符
//   `import ... from "tve"` 即获得引擎 SDK 的智能提示与类型检查；
// - 注册 'tve-dark' 主题（配色对齐 VS Code 默认 Dark+，与编辑器应用主题一致）。
// ---------------------------------------------------------------------------

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
// 引擎 SDK 类型契约（与 public/web-preview/libs/tve.mjs 镜像同步）
import tveDts from "../../../framework/scripting/tve.d.ts?raw";

export type MonacoNamespace = typeof MonacoApi;

let monacoPromise: Promise<MonacoNamespace> | null = null;

/** 与 VS Code「Default Dark+」一致的编辑器配色（monaco vs-dark 的近似还原） */
function registerDarkPlusTheme(monaco: MonacoNamespace): void {
  monaco.editor.defineTheme("tve-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6A9955", fontStyle: "italic" },
      { token: "comment.jsdoc", foreground: "6A9955" },
      { token: "comment.jsdoc.tag", foreground: "9cdcfe" },
      { token: "keyword", foreground: "569CD6" },
      { token: "keyword.flow", foreground: "C586C0" },
      { token: "keyword.json", foreground: "569CD6" },
      { token: "string", foreground: "CE9178" },
      { token: "number", foreground: "B5CEA8" },
      { token: "regexp", foreground: "D16969" },
      { token: "type", foreground: "4EC9B0" },
      { token: "type.identifier", foreground: "4EC9B0" },
      { token: "identifier", foreground: "9CDCFE" },
      { token: "tag", foreground: "569CD6" },
      { token: "delimiter", foreground: "D4D4D4" },
      { token: "operator", foreground: "D4D4D4" },
      { token: "string.key.json", foreground: "9CDCFE" },
      { token: "string.value.json", foreground: "CE9178" },
      { token: "attribute.name", foreground: "9CDCFE" },
      { token: "attribute.value", foreground: "CE9178" },
    ],
    colors: {
      "editor.background": "#1E1E1E",
      "editor.foreground": "#D4D4D4",
      "editorLineNumber.foreground": "#858585",
      "editorLineNumber.activeForeground": "#C6C6C6",
      "editorCursor.foreground": "#AEAFAD",
      "editor.selectionBackground": "#264F78",
      "editor.inactiveSelectionBackground": "#3A3D41",
      "editor.selectionHighlightBackground": "#42000088",
      "editor.wordHighlightBackground": "#57575766",
      "editor.lineHighlightBackground": "#2A2A2A66",
      "editorIndentGuide.background1": "#404040",
      "editorIndentGuide.activeBackground1": "#707070",
      "editorWidget.background": "#252526",
      "editorWidget.border": "#454545",
      "editorSuggestWidget.background": "#252526",
      "editorSuggestWidget.border": "#454545",
      "editorSuggestWidget.selectedBackground": "#04395E",
      "editorSuggestWidget.highlightForeground": "#9CDCFE",
      "editorHoverWidget.background": "#252526",
      "editorHoverWidget.border": "#454545",
      "editorGroupHeader.tabsBackground": "#252526",
      "focusBorder": "#007FD4",
      "input.background": "#3C3C3C",
      "input.border": "#3C3C3C",
      "scrollbarSlider.background": "#79797966",
      "scrollbarSlider.hoverBackground": "#64646466",
      "scrollbarSlider.activeBackground": "#BFBFBF66",
      "minimap.background": "#1E1E1E",
    },
  });
}

/** 懒加载并配置 Monaco（进程内只执行一次） */
export function loadMonaco(): Promise<MonacoNamespace> {
  if (monacoPromise) return monacoPromise;
  monacoPromise = (async () => {
    // editor.main：editor.api 导出 + 全部编辑器 contrib（命令面板/查找/TS 重构等）与
    // 各语言 contribution（typescript monarch 语法着色）一并注册（副作用）。
    const monaco = await import("monaco-editor/esm/vs/editor/editor.main");

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
        allowSyntheticDefaultImports: true,
        // 装饰器（@property / @nodeType，参考 Cocos Creator 写法）
        experimentalDecorators: true,
        noEmit: true,
        lib: ["es2020", "dom"],
      });
      ts.typescriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false,
        noSuggestionDiagnostics: false,
      });
      // 模型变更即时同步语言服务（诊断/跳转更跟手）
      ts.typescriptDefaults.setEagerModelSync(true);
      // 引擎 SDK 类型：解析裸说明符 "tve"（node_modules 查找路径）
      ts.typescriptDefaults.addExtraLib(tveDts, "file:///node_modules/tve/index.d.ts");
    }

    registerDarkPlusTheme(monaco);
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
