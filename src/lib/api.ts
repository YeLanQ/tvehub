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
  /** 扫描内置资源目录（internal/…），返回以 "internal/" 为根的资产条目（真实目录运行时扫描） */
  scanInternalAssets: () => invoke<AssetEntry[]>("scan_internal_assets"),
  /** 读取内置二进制资源（internal/…，如贴图；复制内置资产到项目等一次性操作用），返回 base64 */
  readInternalBinary: (rel: string) => invoke<string>("read_internal_binary", { rel }),
  /** 写入项目内二进制文件（base64 内容；复制内置贴图到项目等用） */
  writeAssetBinary: (root: string, rel: string, contentB64: string) =>
    invoke<void>("write_asset_binary", { root, rel, contentB64 }),
  /** 更新 asset:// 协议的当前项目根（打开项目时必须先调用；null = 关闭项目） */
  setCurrentProjectRoot: (root: string | null) =>
    invoke<void>("set_current_project_root", { root }),
  /** 读取并解析 .mat 材质资产（internal/项目路由与解析均在后端；缺失返回 null） */
  materialRead: (root: string, rel: string) =>
    invoke<{ name: string; materialType: string; params: Record<string, unknown> } | null>(
      "material_read",
      { root, rel },
    ),
  /** 序列化并写入材质资产（后端持有 .mat 格式；自动补 .meta） */
  materialWrite: (
    root: string,
    rel: string,
    name: string,
    materialType: string,
    params: Record<string, unknown>,
  ) => invoke<void>("material_write", { root, rel, name, materialType, params }),
  /** 复制材质为项目资产（internal → assets/materials；后端扫盘去重），返回新相对路径 */
  materialDuplicate: (root: string, srcRel: string, preferName: string) =>
    invoke<string>("material_duplicate", { root, srcRel, preferName }),
  /** 从当前场景导出网页预览产物（scene.json/.mat/贴图由后端直接读盘写入；
   *  files 仅为 WebView 打包的网页运行时 + config.json 文本） */
  exportWebPreviewFromScene: (root: string, sceneRel: string, files: Record<string, string>) =>
    invoke<void>("export_web_preview_from_scene", { root, sceneRel, files }),
  /** 导入选择对话框：多选文件（资产面板「导入」） */
  pickImportFiles: (title?: string) => invoke<string[]>("pick_import_files", { title }),
  /** 导入选择对话框：多选文件夹（资产面板「导入目录」） */
  pickImportFolders: (title?: string) => invoke<string[]>("pick_import_folders", { title }),
  /** 启动网页预览本地静态服务（服务 <root>/.tmp/web-preview，dir 可指定其他产物目录如
   *  "build/web"），返回 base URL */
  startWebPreviewServer: (root: string, dir?: string) =>
    invoke<string>("start_web_preview_server", { root, dir }),
  /** 停止网页预览本地静态服务（释放端口） */
  stopWebPreview: () => invoke<void>("stop_web_preview"),
  /** 构建导出：打包选中场景 + 引用资产 + 网页运行时到 <root>/build/<channel>/
   *  （files 为前端 fetch 的网页运行时文本；场景与资产由后端直读磁盘） */
  buildExport: (args: {
    root: string;
    channel: string;
    scenes: string[];
    mainScene: string;
    title: string;
    debug: boolean;
    /** 产物形态：true = 单页（数据内联 index.html）/ false = 多文件 */
    singlePage: boolean;
    /** 资产 gzip 归档（多文件写 assets.gzip；单页 base64 内联） */
    gzip: boolean;
    files: Record<string, string>;
  }) => invoke<BuildResult>("build_export", args),
};

/** 构建导出结果（与 Rust build::BuildResult 对应） */
export interface BuildResult {
  ok: boolean;
  channel: string;
  /** 输出目录绝对路径 */
  output_dir: string;
  /** 主场景项目相对路径 */
  main_scene: string;
  main_scene_name: string;
  scenes: { name: string; rel: string; file: string }[];
  single_page: boolean;
  gzip: boolean;
  assets_packed: number;
  missing: string[];
  message: string;
}