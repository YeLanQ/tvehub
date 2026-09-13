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

/** 项目信息（open/create/rename/list 返回；scene_count 序列化为 sceneCount） */
export interface RecentProject {
  path: string;
  name: string;
  sceneCount: number;
}

/** 开发者服务连接信息（与 Rust devtools::DevToolsInfo 对应，字段保持 snake_case） */
export interface DevToolsInfo {
  port: number;
  /** 展示用端点（tcp://…）；协议为换行分隔 JSON */
  url: string;
  /** MCP HTTP 端点（http://127.0.0.1:<port>/mcp，同一端口） */
  mcp_url: string;
  /** MCP stdio 桥程序路径（mcp.exe，与主程序同目录） */
  stdio_command: string;
  token: string;
  protocol: string;
}

/** 工具权限项（与 Rust devtools::ToolPermInfo 对应；Rust 权威存储） */
export interface DevToolPermInfo {
  id: string;
  name: string;
  group: string;
  enabled: boolean;
}

/** 创意工坊仓库文件（public/repos/<分类>/<文件>，一个文件一个条目） */
export interface RepoFileEntry {
  /** 文件名（含扩展名，如 "Spin.ts"） */
  file: string;
  /** 显示名（文件名去扩展名） */
  name: string;
  /** 小写扩展名（无扩展名为空串） */
  ext: string;
  /** 首部 // @desc: 注释的描述（缺省空） */
  description: string;
  /** 文件字节数 */
  size: number;
}

/** 创意工坊仓库分类（public/repos 下的子目录：code / effect / …） */
export interface RepoCategoryEntry {
  /** 分类 id（= 目录名） */
  id: string;
  /** 分类目录绝对路径（「在文件夹中打开」用） */
  dir: string;
  /** 分类下的文件（按文件名排序） */
  files: RepoFileEntry[];
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
  /** 读取并解析 .mat 材质资产（internal/项目路由与解析均在后端；shader 引用解析为
   *  materialType 渲染分支；缺失返回 null） */
  materialRead: (root: string, rel: string) =>
    invoke<{
      name: string;
      materialType: string;
      /** 引用的着色器资产相对路径（空串 = 旧格式无引用） */
      shader: string;
      params: Record<string, unknown>;
    } | null>("material_read", { root, rel }),
  /** 序列化并写入材质资产（后端持有 .mat 格式；shader 为着色器资产相对路径，自动补 .meta） */
  materialWrite: (
    root: string,
    rel: string,
    name: string,
    shader: string,
    params: Record<string, unknown>,
  ) => invoke<void>("material_write", { root, rel, name, shader, params }),
  /** 读取并解析 .shader 着色器资产（渲染分支由 Base 声明、Hook 片段、Properties 属性表；
   *  缺失/非着色器文档返回 null） */
  shaderRead: (root: string, rel: string) =>
    invoke<{
      name: string;
      kind: string;
      source: string;
      base: string;
      include: string;
      hooks: { name: string; code: string }[];
      properties: {
        key: string;
        label: string;
        kind: string;
        min?: number | null;
        max?: number | null;
        default: number | number[] | string;
      }[];
      error: string | null;
      suggestedBase: string;
    } | null>("shader_read", { root, rel }),
  /** 序列化并写着色器资产（后端持有 .shader 格式；Shader 指令名取 rel 去扩展名，
   *  与资产路径一致；自动补 .meta） */
  shaderWrite: (root: string, rel: string, kind: string) =>
    invoke<void>("shader_write", { root, rel, kind }),
  /** 保存着色器源码（仅项目内 .shader；指令跟随路径 + 解析校验 + 自动补 .meta），
   *  返回重新解析后的文档（含 Base/钩子/属性表/解析错误） */
  shaderWriteSource: (root: string, rel: string, source: string) =>
    invoke<{
      name: string;
      kind: string;
      source: string;
      base: string;
      include: string;
      hooks: { name: string; code: string }[];
      properties: {
        key: string;
        label: string;
        kind: string;
        min?: number | null;
        max?: number | null;
        default: number | number[] | string;
      }[];
      error: string | null;
      suggestedBase: string;
    }>("shader_write_source", { root, rel, source }),
  /** 复制材质为项目资产（internal → assets/materials；后端扫盘去重），返回新相对路径 */
  materialDuplicate: (root: string, srcRel: string, preferName: string) =>
    invoke<string>("material_duplicate", { root, srcRel, preferName }),
  /** 序列化并写入 TextureCube 资产（后端持有 .texcube 格式；自动补 .meta） */
  texcubeWrite: (
    root: string,
    rel: string,
    name: string,
    source: "equirect" | "faces",
    map: string,
    faces?: Record<string, string> | null,
  ) => invoke<void>("texcube_write", { root, rel, name, source, map, faces: faces ?? null }),
  /** 序列化并写入天空盒材质（.mat；shader/kind + 天空参数；后端持有格式，自动补 .meta） */
  skymatWrite: (root: string, rel: string, name: string, kind: "procedural" | "cube") =>
    invoke<void>("skymat_write", { root, rel, name, kind }),
  /** 序列化并写入地形资产（.terrain；程序化地形设置预设；后端持有格式，自动补 .meta） */
  terrainWrite: (root: string, rel: string, name: string, settings: Record<string, unknown>) =>
    invoke<void>("terrain_write", { root, rel, name, settings }),
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
    /** 发布模式：资源 uid 重命名 + 引用重写 + JSON 压缩 */
    release: boolean;
    /** CDN 模式：three.js 运行时不内嵌（从 Three CDN 地址在线加载） */
    cdn: boolean;
    /** gzip 资源地址（归档远程基址；空 = 本地 assets.gzip） */
    gzipBase: string;
    /** Three CDN 地址（three.js 远程基址；空 = 内嵌 three.js） */
    cdnBase: string;
    files: Record<string, string>;
  }) => invoke<BuildResult>("build_export", args),
  /** 扫描 exe 旁 public 目录下的用户自定义模板
   *  （kind: "templates"=项目模板 / "exports-web"=web 导出模板） */
  scanUserTemplates: (kind: "templates" | "exports-web") =>
    invoke<UserTemplateInfo[]>("scan_user_templates", { kind }),
  /** 读取 exe 旁用户自定义模板的文本文件（如 index.html / 模板内项目文件） */
  readUserTemplateText: (kind: "templates" | "exports-web", dir: string, rel: string) =>
    invoke<string>("read_user_template_text", { kind, dir, rel }),

  // ---------------------------------------------------------------------------
  // 窗口 / 项目生命周期与应用偏好（双窗口架构 + 最近项目）
  // ---------------------------------------------------------------------------

  /** 打开项目（后端登记最近项目并返回项目信息） */
  openProject: (path: string) => invoke<RecentProject>("open_project", { path }),
  /** 从内置模板创建项目（files：相对路径 → 内容；自动生成 .meta 并登记最近） */
  createProject: (
    parent: string,
    name: string,
    templateId: string,
    files: Record<string, string>,
  ) => invoke<RecentProject>("create_project", { parent, name, templateId, files }),
  /** 列出最近项目（后端持久化；按规范化路径去重） */
  listRecentProjects: () => invoke<RecentProject[]>("list_recent_projects"),
  /** 移除最近项目记录（按规范化路径匹配） */
  removeRecentProject: (path: string) => invoke<void>("remove_recent_project", { path }),
  /** 重命名项目目录（最近记录跟随新路径），返回新项目信息 */
  renameProject: (path: string, newName: string) =>
    invoke<RecentProject>("rename_project", { path, newName }),
  /** 把路径移入系统回收站（目录/文件均可） */
  trashPath: (path: string) => invoke<void>("trash_path", { path }),
  /** 选择项目文件夹对话框 */
  pickProjectFolder: () => invoke<string | null>("pick_project_folder"),
  /** 读取默认项目位置（新建项目默认父目录）；未设置返回 null */
  getDefaultProjectDir: () => invoke<string | null>("get_default_project_dir"),
  /** 设置默认项目位置（空值 = 清除） */
  setDefaultProjectDir: (dir: string) => invoke<void>("set_default_project_dir", { dir }),
  /** 扫描创意工坊仓库全部分类（public/repos/*，含各分类文件清单与目录路径） */
  listRepoCategories: () => invoke<RepoCategoryEntry[]>("list_repo_categories"),
  /** 读取仓库文件内容（category 分类目录下的 file；仅文本文件） */
  readRepoFile: (category: string, file: string) =>
    invoke<string>("read_repo_file", { category, file }),
  /** 写入仓库文件（新建/覆盖；目录不存在自动创建） */
  writeRepoFile: (category: string, file: string, code: string) =>
    invoke<void>("write_repo_file", { category, file, code }),
  /** 删除仓库文件 */
  deleteRepoFile: (category: string, file: string) =>
    invoke<void>("delete_repo_file", { category, file }),
  /** 扫描脚本原型目录（repos/code/*.ts 清单，按文件名排序） */
  listCodeProtos: () => invoke<RepoFileEntry[]>("list_code_protos"),
  /** 读取原型文件内容 */
  readCodeProto: (file: string) => invoke<string>("read_code_proto", { file }),
  /** 写入原型文件（新建/覆盖） */
  writeCodeProto: (file: string, code: string) => invoke<void>("write_code_proto", { file, code }),
  /** 删除原型文件 */
  deleteCodeProto: (file: string) => invoke<void>("delete_code_proto", { file }),
  /** 显示编辑器窗口并聚焦（首页打开/新建项目成功后调用） */
  showEditorWindow: () => invoke<void>("show_editor_window"),
  /** 显示首页窗口并隐藏编辑器（编辑器关闭项目后调用） */
  showHomeWindow: () => invoke<void>("show_home_window"),
  /** 追加一行调试日志到应用配置目录 debug.log */
  appendDebugLog: (line: string) => invoke<void>("append_debug_log", { line }),
  /** 打开 WebView 开发者工具（发行构建会返回错误提示） */
  openDevtools: () => invoke<void>("open_devtools"),
  /** 应用相关目录路径（名称有序；前端展示 + opener 打开） */
  devAppDirs: () => invoke<[string, string][]>("dev_app_dirs"),

  // ---------------------------------------------------------------------------
  // 开发者服务（控制服务器 + MCP）：启停 / 状态 / 命令回填 / 事件广播
  // ---------------------------------------------------------------------------

  /** 启动开发者服务控制服务器（幂等；port 为 0/未提供时随机端口） */
  devtoolsStart: (port?: number) =>
    invoke<DevToolsInfo>("devtools_start", { port: port || null }),
  /** 停止开发者服务控制服务器 */
  devtoolsStop: () => invoke<void>("devtools_stop"),
  /** 当前是否已启用（含连接信息；未启用返回 null） */
  devtoolsStatus: () => invoke<DevToolsInfo | null>("devtools_status"),
  /** 工具权限清单（Rust 权威存储；首页启动时同步用） */
  devtoolsTools: () => invoke<DevToolPermInfo[]>("devtools_tools"),
  /** 设置某工具是否启用（持久化到 Rust；返回最新清单） */
  devtoolsSetTool: (id: string, enabled: boolean) =>
    invoke<DevToolPermInfo[]>("devtools_set_tool", { id, enabled }),
  /** 前端执行器回填命令结果（按 replyToken 路由回对应客户端） */
  devtoolsReply: (
    token: string,
    result: unknown,
    error: string | null,
  ) => invoke<void>("devtools_reply", { token, result, error }),
  /** 前端推送事件（console / 日志 / 状态变化）广播给所有控制端 */
  devtoolsPush: (event: string, data: unknown) =>
    invoke<void>("devtools_push", { event, data }),
};

/** 用户自定义模板信息（exe 旁 public 目录扫描结果；与内置注册表字段对齐） */
export interface UserTemplateInfo {
  dir: string;
  name: string;
  description: string;
  mode: string;
  files: string[];
}

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
  release: boolean;
  /** CDN 模式：three.js 不内嵌，从 Three CDN 地址在线加载 */
  cdn: boolean;
  /** 发布模式转为 LQENBIN1 .bin 的模型（项目相对路径） */
  bin_converted: string[];
  assets_packed: number;
  missing: string[];
  message: string;
}