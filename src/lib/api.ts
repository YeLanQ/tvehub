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

/** 一条工具调用记录（助手内部桥 + 控制端 TCP/MCP 统一入账） */
export interface DevCallLogEntry {
  /** Unix 毫秒 */
  ts: number;
  /** assistant = 助手内部桥；control = 控制端（TCP/MCP） */
  source: "assistant" | "control";
  method: string;
  ok: boolean;
  /** 助手路径的耗时毫秒；控制端路径为 0 */
  ms: number;
  detail: string;
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
  /** 序列化并写入地形材质资产（.terrainmat；4 纹理图层 + splatmap + 全局 PBR；后端持有格式，自动补 .meta） */
  terrainmatWrite: (root: string, rel: string, name: string, settings: Record<string, unknown>) =>
    invoke<void>("terrainmat_write", { root, rel, name, settings }),
  /** 序列化并写入状态机资产（.fsm；状态图 JSON 前端已收敛；后端持有格式，自动补 .meta） */
  fsmWrite: (root: string, rel: string, name: string, graph: Record<string, unknown>) =>
    invoke<void>("fsm_write", { root, rel, name, graph }),
  /** 序列化并写入行为树资产（.bt；节点树 JSON 前端已收敛；后端持有格式，自动补 .meta） */
  behaviorTreeWrite: (root: string, rel: string, name: string, tree: Record<string, unknown>) =>
    invoke<void>("behaviortree_write", { root, rel, name, tree }),
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
    /** 产物落盘目录（项目相对路径；缺省 build/<channel>/），如局域网共享用 .tmp/share */
    outDir?: string;
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
  /** 显示目标窗口并写入待交付项目（统一入口：首页打开编辑器/图窗口均经此）。
   *  冷启动时窗口 listen 未就绪，事件广播会丢失，由窗口启动后主动 takePendingProject 拉取 */
  showWindowWithProject: (label: string, root: string, name: string, rel: string | null) =>
    invoke<void>("show_window_with_project", { label, root, name, rel }),
  /** 窗口启动时拉取待交付项目（取走后清空，保证只交付一次） */
  takePendingProject: () =>
    invoke<{ root: string; name: string; rel: string | null } | null>("take_pending_project"),
  /** 显示首页窗口并隐藏编辑器（编辑器关闭项目后调用） */
  showHomeWindow: () => invoke<void>("show_home_window"),
  /** 显示白板窗口（全局单例，不绑定项目；name 非空 = 待打开文件，冷启动拉取兜底） */
  showWhiteboardWindow: (name: string | null) =>
    invoke<void>("show_whiteboard_window", { name }),
  /** 白板窗口启动时拉取待打开文件名（取走即清空） */
  takePendingWhiteboardFile: () =>
    invoke<string | null>("take_pending_whiteboard_file"),
  /** 显示文档窗口（全局单例；hash 非空 = 待打开文档页，冷启动拉取兜底） */
  showDocsWindow: (hash?: string | null) =>
    invoke<void>("show_docs_window", { hash: hash ?? null }),
  /** 文档窗口启动时拉取待打开 hash（取走即清空） */
  takePendingDocsHash: () => invoke<string | null>("take_pending_docs_hash"),
  /** 列出全局白板目录下的 .svg 文件名（按名称排序） */
  whiteboardListFiles: () => invoke<string[]>("whiteboard_list_files"),
  /** 读取全局白板文件内容 */
  whiteboardRead: (name: string) => invoke<string>("whiteboard_read", { name }),
  /** 写入全局白板文件（自动建目录） */
  whiteboardWrite: (name: string, content: string) =>
    invoke<void>("whiteboard_write", { name, content }),
  /** 删除全局白板文件 */
  whiteboardDelete: (name: string) => invoke<void>("whiteboard_delete", { name }),

  // ---------------------------------------------------------------------------
  // 局域网共享：统一配置 / 地址 / 发布产物 / 启停单条共享
  // ---------------------------------------------------------------------------

  /** 当前状态（配置 + 地址候选 + 共享列表）；首次调用顺带从磁盘载入 */
  lanShareStatus: () => invoke<LanShareStatus>("lan_share_status"),
  /** 本机地址清单（配置页地址下拉与排查用） */
  lanShareNetInfo: () => invoke<LanNetInfo>("lan_share_net_info"),
  /** 改配置（补丁式）；端口/网卡/口令变化会重启监听 */
  lanShareSetConfig: (patch: LanShareConfigPatch) =>
    invoke<LanShareStatus>("lan_share_set_config", { patch }),
  /** 开服 */
  lanShareStart: () => invoke<LanShareStatus>("lan_share_start"),
  /** 停服（配置保留） */
  lanShareStop: () => invoke<LanShareStatus>("lan_share_stop"),
  /** 发布托管站点（整站覆盖写；files 为「相对路径 → 文本内容」） */
  lanSharePublishSite: (req: LanPublishSiteRequest) =>
    invoke<LanShareStatus>("lan_share_publish_site", { req }),
  /** 按引用共享一个外部目录（不复制文件，源目录变化即时可见） */
  lanShareAddDir: (req: LanAddDirRequest) =>
    invoke<LanShareStatus>("lan_share_add_dir", { req }),
  /** 启停单条共享（停用后直链 404，记录与文件保留） */
  lanShareSetEnabled: (id: string, enabled: boolean) =>
    invoke<LanShareStatus>("lan_share_set_enabled", { id, enabled }),
  /** 删除共享（托管站点连同站点目录一并删除） */
  lanShareRemove: (id: string) => invoke<LanShareStatus>("lan_share_remove", { id }),

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
  /** 回执：本窗口 devtools:cmd 命令监听器已安装（编辑器窗口启动时调用） */
  devtoolsListenerReady: (label: string) =>
    invoke<void>("devtools_listener_ready", { label }),
  /** 取消指定任务 */
  cancelTask: (id: string) => invoke<boolean>("cancel_task", { id }),
  /** 批量取消某项目的全部任务 */
  cancelTasksByRoot: (root: string) =>
    invoke<number>("cancel_tasks_by_root", { root }),
  /** 列出活跃任务（可选按项目根过滤） */
  listTasks: (root?: string) =>
    invoke<TaskStatus[]>("list_tasks", { root: root ?? null }),

  // ---------------------------------------------------------------------------
  // 助手：LLM 流式外呼（事件回推）+ 全局面板窗口 + devtools 进程内调用桥
  // ---------------------------------------------------------------------------

  /** 发起流式对话（立即返回；增量/结束/错误经 ai:chunk / ai:done / ai:error 事件） */
  aiChatStream: (args: {
    reqId: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    messages: unknown;
    temperature?: number;
  }) => invoke<void>("ai_chat_stream", { args }),
  /** 取消进行中的流式对话（幂等） */
  aiCancel: (reqId: string) => invoke<void>("ai_cancel", { reqId }),
  /** 拉取模型清单（GET /models；部分供应商不支持时前端手填兜底） */
  aiListModels: (baseUrl: string, apiKey: string) =>
    invoke<string[]>("ai_list_models", { baseUrl, apiKey }),
  /** 开/关助手浮动面板（全局单例窗口；返回切换后是否可见） */
  toggleAssistantWindow: () => invoke<boolean>("toggle_assistant_window"),
  /** 助手专用：进程内执行一条 devtools 方法（权限门控 + 编辑器执行器回填） */
  devtoolsCall: (method: string, params?: Record<string, unknown>) =>
    invoke<unknown>("devtools_internal_call", { method, params }),
  /** 最近的工具调用记录（助手 + 控制端统一入账，最新在后） */
  devtoolsRecentCalls: () => invoke<DevCallLogEntry[]>("devtools_recent_calls"),

  // ---------------------------------------------------------------------------
  // 助手会话独立存储（配置根/assistant/conversations/：index.json + conv-<id>.json，
  // 原子写）。与 ui-state 分离：会话是数据不是界面状态，索引整体覆盖的事故
  // 影响面收窄到单文件；历史 ui-state 键由后端 setup 一次性迁移。
  // ---------------------------------------------------------------------------

  assistantConvIndexGet: () => invoke<string | null>("assistant_conv_index_get"),
  assistantConvIndexSet: (value: string) => invoke<void>("assistant_conv_index_set", { value }),
  assistantConvDocGet: (id: string) => invoke<string | null>("assistant_conv_doc_get", { id }),
  assistantConvDocSet: (id: string, value: string) =>
    invoke<void>("assistant_conv_doc_set", { id, value }),
  assistantConvDocDelete: (id: string) => invoke<void>("assistant_conv_doc_delete", { id }),

  // ---------------------------------------------------------------------------
  // 助手大脑（Rust brain 模块）：知识图谱检索 / 策略门控 / 观测回写
  // ---------------------------------------------------------------------------

  /** 语义检索：任务文本 → 相关节点（技能/命令/概念，按综合分降序） */
  brainQuery: (text: string, topK?: number) =>
    invoke<BrainRouteHit[]>("brain_query", { text, topK: topK ?? null }),
  /** 策略规划：任务 → 主技能 + 推荐步骤 + 效能门控决策 */
  brainPlan: (task: string) => invoke<BrainPlan>("brain_plan", { task }),
  /** 语义单元化：任务 →（分段 → 神经图检索 → 命令预测）→ 单元任务 + 处理轨迹；
   * root 为当前工作区（注入 scene.list/asset.list 直执行参数） */
  brainDecompose: (task: string, root?: string) =>
    invoke<BrainDecomposition>("brain_decompose", { task, root: root ?? null }),
  /** 观测回写：一次工具执行的耗时与成败（驱动因果链进化与效能统计） */
  brainObserve: (args: { task: string; method: string; ok: boolean; ms: number }) =>
    invoke<BrainObserveReport>("brain_observe", { args }),
  /** 大脑状态报表（节点分布/向量压缩/台账/决策计数） */
  brainStats: () => invoke<BrainStatsReport>("brain_stats"),
  /**
   * 大脑决策中心执行一个工具调用（助手工具统一入口）：后端门控（行动边界
   * 三区 + 任务审批会话 + 效能比）→ devtools 命令模式派发 → 观测回写。黄灯
   * 未批准返回 needConfirm（未执行），请求用户批准（brainApprove）后重发即可。
   */
  brainExecute: (args: { task: string; method: string; params?: Record<string, unknown> }) =>
    invoke<BrainExecOutcome>("brain_execute", { args }),
  /** 登记任务审批会话：批准后该任务的黄灯调用在有效期内直接放行 */
  brainApprove: (task: string) => invoke<void>("brain_approve", { task }),
  /** 内嵌技能全文（load_skill 兜底源：前端注册表是子集，id 以构建期内嵌表为准） */
  brainSkillGet: (id: string) =>
    invoke<{ id: string; name: string; description: string; body: string } | null>(
      "brain_skill_get",
      { id },
    ),
  /** 内嵌 docs 文档全文（load_doc 直答，只读无副作用，不经决策中心） */
  docsRead: (id: string) =>
    invoke<{ id: string; title: string; summary: string; body: string } | null>("docs_read", {
      id,
    }),
};

// ---------------------------------------------------------------------------
// 助手大脑类型（与 Rust brain::dto / policy::strategy 的 camelCase 序列化对应）
// ---------------------------------------------------------------------------

export interface BrainRouteHit {
  id: string;
  kind: "skill" | "command" | "concept";
  label: string;
  score: number;
}

export interface BrainPlanStep {
  method: string;
  /** green = 只读可自主执行；yellow = 写操作需用户确认 */
  zone: "green" | "yellow";
  ratio: number;
}

export interface BrainPlan {
  task: string;
  decision: "autoExecute" | "needConfirm" | "deny";
  reason: string;
  /** 全计划瓶颈效能比（0..1，自主执行门槛 0.99） */
  ratio: number;
  skills: BrainRouteHit[];
  steps: BrainPlanStep[];
}

/** 图谱命中的权威知识（技能/文档）：只给「是什么+怎么取」，全文按需拉取 */
export interface BrainKnowledgeHit {
  /** 节点 id："skill:<id>" / "concept:doc:<path>" */
  id: string;
  label: string;
}

/** 语义单元任务（brain_decompose 产物；预测方法只是入口建议） */
export interface BrainTaskUnit {
  /** 1 起始序号 */
  index: number;
  /** 语义段原文 */
  text: string;
  /** 预测的 devtools 方法（无预测为 null） */
  method: string | null;
  /** 预测依据："graph"（神经图命令节点）| "lexicon"（关键词词典） */
  source: string | null;
  /** 该方法的行动边界（无预测为 null） */
  zone: "green" | "yellow" | "red" | null;
  /** 任务阶段：inspect 调研 / act 执行 / verify 验证 */
  phase: "inspect" | "act" | "verify";
  /** 图谱参考知识：本段命中的技能/概念（转发给助手深查，不参与门控） */
  refs: BrainKnowledgeHit[];
  /** 执行模式：direct 准确性原子任务（大脑直执行）/ assist 模糊原子任务（助手细化） */
  exec: "direct" | "assist";
  /** direct 单元的直执行参数（assist 为 null） */
  params: Record<string, unknown> | null;
}

/** 处理轨迹短句（过程容器逐条上屏） */
export interface BrainNluTrace {
  stage: string;
  detail: string;
}

/** 语义单元化产物：任务原文 + 单元序列 + 处理轨迹 + 整任务知识命中 */
export interface BrainDecomposition {
  task: string;
  units: BrainTaskUnit[];
  traces: BrainNluTrace[];
  /** 整任务粒度的图谱知识命中（直通路线注入助手上下文的来源） */
  refs: BrainKnowledgeHit[];
}

export interface BrainObserveReport {
  chainId: string;
  ratio: number;
  accuracy: number;
  autoEligible: boolean;
  ticked: unknown | null;
}

/** 大脑决策中心执行回执（与 Rust brain::execute::ExecOutcome 对应） */
export interface BrainExecOutcome {
  /** ok=已执行（结果在 result，工具失败以 result.error 表达）；
   * needConfirm=黄灯未批准未执行；denied=拒绝执行 */
  status: "ok" | "needConfirm" | "denied";
  decision: "autoExecute" | "needConfirm" | "deny";
  /** green 只读 / yellow 写操作 / red 禁止 */
  zone: "green" | "yellow" | "red";
  reason: string;
  /** 该方法当前效能比（0..1） */
  ratio: number;
  result?: unknown;
}

export interface BrainStatsReport {
  nodesByKind: Record<string, number>;
  edges: number;
  chains: number;
  coldEntries: number;
  vectorRawBytes: number;
  vectorStoredBytes: number;
  mergedTotal: number;
  ticks: number;
  totalEnergy: number;
  globalAccuracy: number;
  decisions: { autoExecute: number; needConfirm: number; denied: number };
  methods: Array<{ method: string; attempts: number; successes: number; avgMs: number; ratio: number }>;
}

// ---------------------------------------------------------------------------
// 局域网共享（与 Rust lanshare 模块对应）
// ---------------------------------------------------------------------------

/** 统一配置（Rust 权威存储；落 <config_root>/lan-share/config.json） */
export interface LanShareConfig {
  enabled: boolean;
  port: number;
  /** 绑定网卡：空 = 绑定全部网卡（0.0.0.0）；填具体 IPv4 则只在该网卡监听 */
  host: string;
  deviceName: string;
  autoStart: boolean;
  /** 访问口令：非空时访问者需输入（明文 HTTP，仅防误入，不作安全边界） */
  accessCode: string;
  /** 站点页是否显示「下载源文件」入口 */
  allowDownload: boolean;
}

/** 配置补丁：只提交要改的字段 */
export interface LanShareConfigPatch {
  enabled?: boolean;
  port?: number;
  host?: string;
  deviceName?: string;
  autoStart?: boolean;
  accessCode?: string;
  allowDownload?: boolean;
}

/** 一个候选访问地址（ip + 可直接拼链接的 base URL） */
export interface LanShareUrl {
  ip: string;
  /** 默认路由所在地址（前端取它编二维码） */
  primary: boolean;
  /** 私有网段地址 */
  private: boolean;
  url: string;
}

/** 一条共享（与 Rust share::LanShare 对应） */
export interface LanShareEntry {
  id: string;
  /** 产物类型：whiteboard（白板放映页）/ site（网页产物）/ folder（目录共享） */
  kind: string;
  title: string;
  note: string;
  /** 来源标识（白板文件名 / 绝对目录），同一来源再次发布会原地更新 */
  source: string;
  entry: string;
  /** 站点根目录绝对路径 */
  root: string;
  /** true = 托管站点（在 lan-share/sites/<id>/ 下）；false = 目录引用 */
  managed: boolean;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  fileCount: number;
  size: number;
  /** 访问统计（内存态，重启归零） */
  hits: number;
  lastAccess: number;
  lastClient: string;
}

/** 服务状态快照 */
export interface LanShareStatus {
  config: LanShareConfig;
  running: boolean;
  /** 实际监听端口（配置端口被占用时会回退） */
  port: number;
  bound: string;
  /** 需要提示用户的信息（端口回退等） */
  notice: string | null;
  urls: LanShareUrl[];
  shares: LanShareEntry[];
}

export interface LanAddress {
  ip: string;
  primary: boolean;
  private: boolean;
}

export interface LanNetInfo {
  hostname: string;
  deviceName: string;
  addresses: LanAddress[];
}

/** 发布托管站点请求（files = 相对路径 → 文本内容，整站覆盖写） */
export interface LanPublishSiteRequest {
  kind: string;
  title: string;
  note?: string;
  source?: string;
  entry?: string | null;
  files: Record<string, string>;
  /** 已有托管共享 id：传入则原地更新 */
  shareId?: string | null;
}

/** 按引用共享外部目录请求 */
export interface LanAddDirRequest {
  title: string;
  note?: string;
  dir: string;
  /** 来源标识（稳定业务键）：同一来源再次发布即原地更新；缺省用目录绝对路径 */
  source?: string;
  entry?: string | null;
  shareId?: string | null;
}

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
/** 任务优先级（与 Rust task::Priority 对应） */
export type TaskPriority = "low" | "normal" | "high";

/** 任务状态快照（与 Rust task::TaskStatus 对应） */
export interface TaskStatus {
  id: string;
  kind: string;
  root: string | null;
  priority: TaskPriority;
  progress: number;
  message: string;
  running: boolean;
  cancelled: boolean;
}

/** 任务进度事件（task:progress） */
export interface TaskProgressEvent {
  id: string;
  progress: number;
  message: string;
}

/** 任务完成事件（task:completed） */
export interface TaskCompletedEvent {
  id: string;
  success: boolean;
  message: string;
}