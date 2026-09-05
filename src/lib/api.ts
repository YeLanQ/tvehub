import { invoke } from "@tauri-apps/api/core";

/** 单个资产条目（后端 scan_assets 结果） */
export interface AssetEntry {
  name: string;
  /** 相对项目根路径（正斜杠） */
  path: string;
  /** "dir" 或小写扩展名（如 "scene"、"ts"） */
  kind: string;
  size: number;
}

export interface MetaEntry {
  uuid: string;
  url: string;
  sizeGrid: string | null;
}

/** Tauri 资产命令封装 */
export const api = {
  scanAssets: (root: string) => invoke<AssetEntry[]>("scan_assets", { root }),
  scanAssetDb: (root: string) => invoke<MetaEntry[]>("scan_asset_db", { root }),
  readText: (root: string, rel: string) => invoke<string>("read_text", { root, rel }),
  writeText: (root: string, rel: string, content: string) =>
    invoke<void>("write_text", { root, rel, content }),
  readAssetMeta: (root: string, rel: string) =>
    invoke<Record<string, unknown> | null>("read_asset_meta", { root, rel }),
  writeAssetMeta: (root: string, rel: string, meta: Record<string, unknown>) =>
    invoke<void>("write_asset_meta", { root, rel, meta }),
  ensureProjectMeta: (root: string) => invoke<void>("ensure_project_meta", { root }),
  copyAsset: (root: string, rel: string) => invoke<string>("copy_asset", { root, rel }),
  importAssets: (root: string, destDir: string, sourcePaths: string[]) =>
    invoke<string[]>("import_assets", { root, destDir, sourcePaths }),
  moveAsset: (root: string, rel: string, destDir: string) =>
    invoke<string>("move_asset", { root, rel, destDir }),
  deleteAsset: (root: string, rel: string) => invoke<void>("delete_asset", { root, rel }),
  renameAsset: (root: string, rel: string, newName: string) =>
    invoke<string>("rename_asset", { root, rel, newName }),
  createFolder: (root: string, rel: string) => invoke<string>("create_folder", { root, rel }),
  /** 读取编辑器内置资源（internal/…，只读；内容编译期内嵌） */
  readInternalAsset: (rel: string) => invoke<string>("read_internal_asset", { rel }),
  /** 导出网页预览产物（相对路径 → 内容）到 <root>/.tmp/web-preview（不启停服务器） */
  exportWebPreview: (root: string, files: Record<string, string>) =>
    invoke<void>("export_web_preview", { root, files }),
  /** 启动网页预览本地静态服务（服务 <root>/.tmp/web-preview），返回 base URL */
  startWebPreviewServer: (root: string) => invoke<string>("start_web_preview_server", { root }),
  /** 停止网页预览本地静态服务（释放端口） */
  stopWebPreview: () => invoke<void>("stop_web_preview"),
};