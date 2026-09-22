// devtools 拆解 —— state：开发者服务的类型、工具/权限清单、后端 UI 状态 KV 持久化与
// 全局响应式状态（首页「开发者服务」面板绑定）。无编辑动作逻辑。
//
// 注意双窗口架构：权限在首页窗口（home）里勾选，而方法执行器跑在编辑器窗口（main），
// 两个 WebView 的 reactive 副本互不相通。因此 isToolAllowed 读取内存镜像（boot 时从后端 KV 水合）
// （同源共享），保证勾选即时对执行端生效。

import { reactive } from "vue";
import { api } from "../../../lib/api";
import { uiStateGet, uiStateSet, onUiStateChange } from "../../../lib/ui-state";

export interface DevToolsInfo {
  port: number;
  url: string;
  mcp_url: string;
  stdio_command: string;
  token: string;
  protocol: string;
}

/** 开发者服务的权限工具：每个工具可单独启用/禁用（禁用后其方法返回「工具未启用」错误） */
export interface DevToolPerm {
  id: string;
  name: string;
  /** 权限分组名（「工具权限」界面按此分组展示） */
  group: string;
  enabled: boolean;
}

const DEFAULT_TOOLS: DevToolPerm[] = [
  // 编辑器组
  { id: "editor", name: "编辑器状态", group: "编辑器", enabled: true },
  { id: "projectQuery", name: "查询项目", group: "编辑器", enabled: true },
  { id: "projectOpen", name: "打开/关闭项目", group: "编辑器", enabled: true },
  { id: "projectCreate", name: "新建项目", group: "编辑器", enabled: true },
  // 场景组
  { id: "scene", name: "场景", group: "场景", enabled: true },
  // 节点组
  { id: "node", name: "节点选中", group: "节点", enabled: true },
  { id: "nodeAdd", name: "添加节点", group: "节点", enabled: true },
  { id: "nodeDelete", name: "删除节点", group: "节点", enabled: true },
  { id: "nodeSet", name: "节点设置", group: "节点", enabled: true },
  // 状态组
  { id: "state", name: "状态快照", group: "状态", enabled: true },
  // 预览组
  { id: "previewOpen", name: "打开预览", group: "预览", enabled: true },
  { id: "previewClose", name: "关闭预览", group: "预览", enabled: true },
  { id: "previewStart", name: "启动预览", group: "预览", enabled: true },
  { id: "previewStop", name: "停止预览", group: "预览", enabled: true },
  // 屏幕快照组
  { id: "screenScreenshot", name: "截图", group: "屏幕快照", enabled: true },
  // 资源组（新建/删除/重命名/列出资产文件）
  { id: "assetList", name: "资源列表", group: "资源", enabled: true },
  { id: "assetRead", name: "读取资源内容", group: "资源", enabled: true },
  { id: "assetWrite", name: "写入资源内容", group: "资源", enabled: true },
  { id: "assetCreate", name: "新建资源", group: "资源", enabled: true },
  { id: "assetSelect", name: "选中资源", group: "资源", enabled: true },
  { id: "assetDelete", name: "删除资源", group: "资源", enabled: true },
  { id: "assetRename", name: "重命名资源", group: "资源", enabled: true },
];

/** MCP 服务暴露的工具清单（name + description）：MCP 客户端可调用这些工具操控编辑器 */
export const MCP_TOOLS: { name: string; description: string }[] = [
  { name: "editor.state", description: "获取编辑器当前状态（项目/场景/选中/视图）" },
  { name: "project.list", description: "列出最近打开的项目" },
  { name: "project.open", description: "打开指定路径的项目" },
  { name: "project.close", description: "关闭当前项目（返回首页）" },
  { name: "project.create", description: "新建项目（默认 3D 模板；name 必填，parent 缺省用默认项目位置）" },
  { name: "scene.list", description: "列出项目内的 .scene 场景文件" },
  { name: "scene.open", description: "打开指定场景" },
  { name: "scene.save", description: "保存当前场景" },
  { name: "scene.tree", description: "获取当前场景的完整 JSON 文档" },
  { name: "node.select", description: "选中场景节点" },
  { name: "node.add", description: "在指定父节点下新增节点（kind: group/mesh/light/camera/skybox/fog/audio/particle/terrain/nav/logic/ui/script/model；mesh/light 可带 subtype；script 用 rel=脚本 .ts 路径；model/audio/terrain 用 path 资产路径；parentId/parent 指定父节点）" },
  { name: "node.remove", description: "删除节点" },
  { name: "node.rename", description: "重命名节点" },
  { name: "node.set", description: "设置节点属性（{id,prop,value} 单属性或 {id,...字段} 字段包 name/visible/tag/transform…；transform 分量逐轴部分合并；写入节点 JSON 并走撤销历史）" },
  { name: "preview.open", description: "打开网页预览（导出并启动预览面板）" },
  { name: "preview.close", description: "关闭预览面板，返回场景编辑" },
  { name: "preview.start", description: "启动预览服务器（按现有导出产物）" },
  { name: "preview.stop", description: "停止预览服务器" },
  { name: "preview.screenshot", description: "截取当前视口画面（返回 base64 PNG，并存入项目 .tmp/devtools/）" },
  { name: "state.snapshot", description: "场景状态快照（完整 JSON 文档）" },
  { name: "state.restore", description: "恢复场景快照（传入 state.snapshot 返回的 doc）" },
  { name: "asset.list", description: "列出项目资源（脚本/场景/材质/贴图/目录等，含相对路径与类型）" },
  { name: "asset.create", description: "新建资源文件或目录（type: scene/script/material/shader/texcube/skybox/prefab/anim/terrain/folder；dir 目标目录；name 名称；shader 可带 shaderKind: physical/unlit/toon/skyprocedural/skycube）" },
  { name: "asset.select", description: "选中资产（path：项目相对路径；属性面板切换到资产预览/属性）" },
  { name: "asset.delete", description: "删除资源文件或目录（path：项目相对路径）" },
  { name: "asset.rename", description: "重命名资源文件或目录（path + newName）" },
  { name: "asset.read", description: "读取项目内文本资产内容（可带 root 指定工作区项目目录）" },
  { name: "asset.write", description: "写入项目内文本资产（自动建父目录；可带 root 指定工作区项目目录）" },
];

/** method -> 所属工具 id（权限门控用）；未列出的方法（ping / devtools.stop 等）不受权限控制 */
const METHOD_TOOL: Record<string, string> = {
  "editor.state": "editor",
  "project.list": "projectQuery",
  "project.open": "projectOpen",
  "project.close": "projectOpen",
  "project.create": "projectCreate",
  "scene.list": "scene",
  "scene.open": "scene",
  "scene.save": "scene",
  "scene.tree": "scene",
  "node.select": "node",
  "node.add": "nodeAdd",
  "node.remove": "nodeDelete",
  "node.rename": "nodeSet",
  "node.set": "nodeSet",
  "preview.start": "previewStart",
  "preview.stop": "previewStop",
  "preview.open": "previewOpen",
  "preview.close": "previewClose",
  "preview.screenshot": "screenScreenshot",
  "state.snapshot": "state",
  "state.restore": "state",
  "asset.list": "assetList",
  "asset.read": "assetRead",
  "asset.write": "assetWrite",
  "asset.create": "assetCreate",
  "asset.select": "assetSelect",
  "asset.delete": "assetDelete",
  "asset.rename": "assetRename",
};

/**
 * 远程方法 -> 命令 id（devtools 适配层据此走统一命令执行器）。
 * 与 MCP_TOOLS/METHOD_TOOL 同为本文件的远程契约（方法名/工具 id/命令路由单源）；
 * 执行主体始终是 src/app/commands 命令注册表，注册表缺命令时 handleMethod 报错提示。
 */
export const METHOD_TO_COMMAND: Record<string, string> = {
  "editor.state": "editor.state",
  "project.list": "project.recentList",
  "project.open": "project.open",
  "project.close": "project.close",
  "scene.list": "scene.list",
  "scene.open": "scene.open",
  "scene.save": "scene.save",
  "scene.tree": "scene.doc",
  "node.select": "node.select",
  "node.add": "node.add",
  "node.remove": "node.delete",
  "node.rename": "node.rename",
  "node.set": "node.set",
  "preview.open": "preview.open",
  "preview.close": "preview.close",
  "preview.start": "preview.start",
  "preview.stop": "preview.stop",
  "preview.screenshot": "preview.screenshot",
  "state.snapshot": "scene.doc",
  "state.restore": "state.restore",
  "asset.list": "asset.list",
  "asset.create": "asset.create",
  "asset.select": "asset.select",
  "asset.delete": "asset.delete",
  "asset.rename": "asset.rename",
};

/** 控制服务器默认端口（应用启动自动绑定；与 Rust devtools::DEFAULT_PORT 对应） */
export const DEVTOOLS_DEFAULT_PORT = 39100;

const PERMS_KEY = "tve.devtools.perms";
const PORT_KEY = "tve.devtools.port";

/** 权限内存镜像：isToolAllowed 保持同步读取；boot 时从后端 KV 水合 */
const permsMirror: Record<string, boolean> = {};
let portMirror = 0;

function loadPerms(): Record<string, boolean> {
  return permsMirror;
}

function persistPerms(): void {
  const m: Record<string, boolean> = {};
  for (const t of devtools.tools) m[t.id] = t.enabled;
  void uiStateSet(PERMS_KEY, m);
}

function loadPort(): number {
  return portMirror;
}

function persistPort(): void {
  void uiStateSet(PORT_KEY, devtools.port);
}

/** UI 可绑定的开发者服务状态（首页「开发者服务」面板） */
export const devtools = reactive({
  enabled: false,
  info: null as DevToolsInfo | null,
  error: null as string | null,
  /** 固定端口号（0 = 自动随机；>0 时启用服务绑定该端口） */
  port: loadPort(),
  tools: DEFAULT_TOOLS.map((t) => ({ ...t, enabled: loadPerms()[t.id] !== false })),
  /** 最近工具调用（助手 + 控制端统一入账；refreshRecentCalls 拉取） */
  recent: [] as Awaited<ReturnType<typeof api.devtoolsRecentCalls>>,
});

/** 拉取最近调用记录（开发者服务面板「最近调用」展示；失败静默保留旧值） */
export async function refreshRecentCalls(): Promise<void> {
  try {
    devtools.recent = await api.devtoolsRecentCalls();
  } catch {
    // 非 Tauri 环境 / 后端暂不可用：保留旧值
  }
}

// 启动水合：从后端 KV 读权限/端口镜像，并订阅跨窗口变更
void (async () => {
  const perms = await uiStateGet<Record<string, boolean>>(PERMS_KEY);
  if (perms) Object.assign(permsMirror, perms);
  portMirror = (await uiStateGet<number>(PORT_KEY)) ?? 0;
  devtools.port = portMirror;
  for (const t of devtools.tools) {
    if (permsMirror[t.id] !== undefined) t.enabled = permsMirror[t.id] !== false;
  }
  void onUiStateChange<number>(PORT_KEY, (p) => {
    portMirror = Number(p) || 0;
    devtools.port = portMirror;
  });
  void onUiStateChange<Record<string, boolean>>(PERMS_KEY, (m) => {
    if (!m) return;
    Object.assign(permsMirror, m);
    for (const t of devtools.tools) {
      if (permsMirror[t.id] !== undefined) t.enabled = permsMirror[t.id] !== false;
    }
  });
})();



/** 设置固定端口并持久化（启动服务时按此端口绑定） */
export function setDevToolsPort(port: number): void {
  devtools.port = Number.isFinite(port) ? Math.max(0, Math.min(65535, Math.round(port))) : 0;
  persistPort();
}

/** 设置某工具是否启用：先即时更新本地（reactive + 后端 KV），再持久化到 Rust 权威存储 */
export async function setToolEnabled(id: string, enabled: boolean): Promise<void> {
  const t = devtools.tools.find((x) => x.id === id);
  if (t) {
    t.enabled = enabled;
    persistPerms();
  }
  try {
    await api.devtoolsSetTool(id, enabled);
  } catch (e) {
    console.error("持久化工具权限到 Rust 失败:", e);
  }
}

/** 从 Rust 权威存储同步工具权限（首页启动时调用；同时写入后端 KV 供编辑器窗口跟随） */
export async function syncPermsFromBackend(): Promise<void> {
  try {
    const list = await api.devtoolsTools();
    const m: Record<string, boolean> = {};
    for (const info of list) {
      const t = devtools.tools.find((x) => x.id === info.id);
      if (t) {
        t.name = info.name;
        t.group = info.group;
        t.enabled = info.enabled;
      }
      m[info.id] = info.enabled;
    }
    persistPerms();
  } catch {
    // 无后端（浏览器直开/服务未启用）时保持本地默认
  }
}

/** method 是否被权限允许（未在 METHOD_TOOL 中的方法一律允许）。
 *  读内存镜像：权限在首页窗口勾选，经后端 KV 广播到各窗口。 */
export function isToolAllowed(method: string): boolean {
  const id = METHOD_TOOL[method];
  if (!id) return true;
  const saved = loadPerms();
  if (id in saved) return saved[id] !== false;
  return true;
}

/** method -> 所属工具 id（供路由侧拼权限错误提示；未登记返回 undefined） */
export function methodToolId(method: string): string | undefined {
  return METHOD_TOOL[method];
}

/** MCP 工具名规整：MCP 工具名只允许 [a-z0-9_-]，把方法名里的 '.' 换成 '_' 并小写。 */
export function sanitizeMcpName(method: string): string {
  return method.replace(/\./g, "_").toLowerCase();
}

/** MCP 服务实际暴露的工具：仅含「工具权限」中已启用的方法 */
export function enabledMcpTools(): { name: string; description: string }[] {
  return MCP_TOOLS.filter((t) => isToolAllowed(t.name));
}
