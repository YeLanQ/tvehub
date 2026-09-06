// Monaco 深路径模块的类型补齐（monaco-editor 仅对标准入口暴露类型）。
// editor.main：聚合 editor.api 的全部导出 —— 类型与 editor.api 一致，
// 运行时同时带副作用注册全部编辑器 contrib 与语言（css/html/json/typescript）。
declare module "monaco-editor/esm/vs/editor/editor.main" {
  export * from "monaco-editor/esm/vs/editor/editor.api";
}
