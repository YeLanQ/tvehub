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
  /** 扫描内置资源目录（internal/…），返回以 "internal/" 为根的资产条目（LQEN 同款：真实目录运行时扫描） */
  scanInternalAssets: () => invoke<AssetEntry[]>("scan_internal_assets"),
  /** 读取内置二进制资源（internal/…，如贴图），返回 base64 */
  readInternalBinary: (rel: string) => invoke<string>("read_internal_binary", { rel }),
  /** 读取项目内二进制文件（纹理等图片），返回 base64 文本 */
  readAssetBinary: (root: string, rel: string) =>
    invoke<string>("read_asset_binary", { root, rel }),
  /** 写入项目内二进制文件（base64 内容；复制内置贴图到项目等用） */
  writeAssetBinary: (root: string, rel: string, contentB64: string) =>
    invoke<void>("write_asset_binary", { root, rel, contentB64 }),
  /** 导入选择对话框：多选文件（资产面板「导入」） */
  pickImportFiles: (title?: string) => invoke<string[]>("pick_import_files", { title }),
  /** 导入选择对话框：多选文件夹（资产面板「导入目录」） */
  pickImportFolders: (title?: string) => invoke<string[]>("pick_import_folders", { title }),
  /** 导出网页预览产物（相对路径 → 内容）到 <root>/.tmp/web-preview（不启停服务器）；
   *  binaries 为相对路径 → base64 的二进制资产（贴图等） */
  exportWebPreview: (
    root: string,
    files: Record<string, string>,
    binaries?: Record<string, string>,
  ) => invoke<void>("export_web_preview", { root, files, binaries: binaries ?? {} }),
  /** 启动网页预览本地静态服务（服务 <root>/.tmp/web-preview），返回 base URL */
  startWebPreviewServer: (root: string) => invoke<string>("start_web_preview_server", { root }),
  /** 停止网页预览本地静态服务（释放端口） */
  stopWebPreview: () => invoke<void>("stop_web_preview"),
};