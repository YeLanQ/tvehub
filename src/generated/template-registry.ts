// 由 vite.config.ts 模板索引插件自动生成（模板目录变化时重建；请勿手动编辑）
export interface BuiltinProjectTemplateInfo { id: string; dir: string; name: string; description: string; kind: string; files: string[]; }
export const PROJECT_TEMPLATES: BuiltinProjectTemplateInfo[] = [
  {
    "id": "builtin:3d",
    "dir": "3d",
    "name": "3D 模板",
    "description": "默认 3D 场景",
    "kind": "3d",
    "files": [
      "project.config.json",
      "assets/Main.scene",
      "src/main.ts"
    ]
  }
];
export interface BuiltinWebExportTemplateInfo { id: string; dir: string; name: string; description: string; mode: "multi" | "single"; }
export const WEB_EXPORT_TEMPLATES: BuiltinWebExportTemplateInfo[] = [
  {
    "id": "web:multi",
    "dir": "multi",
    "name": "多文件构建",
    "description": "场景与资产按相对路径落盘，适合部署到静态服务器",
    "mode": "multi"
  },
  {
    "id": "web:single",
    "dir": "single",
    "name": "单页构建",
    "description": "场景与资产内联进 index.html，便于单文件分发",
    "mode": "single"
  }
];
