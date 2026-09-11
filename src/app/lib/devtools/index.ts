// devtools 拆解 —— index：开发者服务（前端侧）控制服务入口。
// 职责：服务启停/状态恢复、Tauri 命令监听与应答、方法路由（handlers.ts）、
// 控制台日志推送。权限/状态与清单见 ./state。
//
// 与 src-tauri/src/devtools.rs 对应：Rust 把需要前端执行的命令经 Tauri 事件
// `devtools:cmd` 转发到这里。执行前先做**工具权限**门控（每个工具可单独启用/禁用），
// 执行后经 `devtools_reply` 回填结果；并把控制台新增日志经 `devtools_push` 广播给
// 所有控制端。协议：TCP 换行分隔 JSON。
//
// 双窗口注意：**只有编辑器窗口**（main）安装 devtools:cmd 监听器——事件会广播到
// 所有窗口，首页窗口若也监听会导致同一命令被执行两次。首页只做启停与状态展示。

import { listen, emit, type UnlistenFn } from "@tauri-apps/api/event";
import { watch } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { logStore } from "../../stores/log";
import { debugLog } from "../../../lib/debug-log";
import { api } from "../../../lib/api";
import { type DevToolsInfo, devtools, isToolAllowed, methodToolId, DEVTOOLS_DEFAULT_PORT } from "./state";

export type { DevToolsInfo, DevToolPerm } from "./state";
export {
  MCP_TOOLS,
  devtools,
  setDevToolsPort,
  setToolEnabled,
  sanitizeMcpName,
  enabledMcpTools,
} from "./state";

let unlistenCmd: UnlistenFn | null = null;
let logWatchStarted = false;

/** 命令执行器只允许挂在编辑器窗口（main）：事件广播到所有窗口，若首页也监听，
 *  同一命令会在两个窗口各执行一次（首页还缺场景/引擎状态）。首页只启停/展示。 */
function isEditorWindow(): boolean {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    // 浏览器/单窗口兜底：视为编辑器执行端
    return true;
  }
}

/** 启动开发者服务控制服务器（幂等；已运行则复用连接信息）。
 *  编辑器窗口启用时挂命令监听器；首页启用仅启停服务器并通知编辑器补挂执行器。 */
export async function startDevTools(): Promise<DevToolsInfo> {
  try {
    const info = await api.devtoolsStart(
      // 未设置固定端口时用应用默认端口（与自动启动一致），被占用由用户改端口或清零回随机
      devtools.port > 0 ? devtools.port : DEVTOOLS_DEFAULT_PORT,
    );
    devtools.enabled = true;
    devtools.info = info;
    devtools.error = null;
    if (isEditorWindow()) {
      await installCmdListener();
      startLogPush();
      debugLog("devtools", `开发者服务已启用：${info.url}（协议 ${info.protocol}）`);
    } else {
      // 编辑器窗口是常驻执行端：通知它（重新）确认监听器就绪（幂等）
      void emit("devtools:enabled", { port: info.port });
    }
    return info;
  } catch (e: any) {
    devtools.error = String(e?.message ?? e);
    debugLog("devtools", `开发者服务启动失败: ${devtools.error}`);
    throw e;
  }
}

/** 停止开发者服务控制服务器（释放端口；供首页开关与控制端 devtools.stop 调用） */
export async function stopDevTools(): Promise<void> {
  try {
    await api.devtoolsStop();
  } catch (e: any) {
    debugLog("devtools", `停止失败: ${e}`);
  }
  devtools.enabled = false;
  devtools.info = null;
  unlistenCmd?.();
  unlistenCmd = null;
  debugLog("devtools", "开发者服务已停止");
}

/** 查询当前是否启用（含连接信息）；页面启动时恢复开关状态 */
export async function devtoolsStatus(): Promise<DevToolsInfo | null> {
  try {
    return await api.devtoolsStatus();
  } catch {
    return null;
  }
}

/**
 * 恢复启用状态（编辑器窗口启动时调用）：服务已在运行则安装命令监听器并接续日志推送。
 * 仅编辑器窗口调用；首页窗口用 syncDevToolsStatus 只同步展示状态。
 */
export async function restoreDevToolsStatus(): Promise<void> {
  const info = await devtoolsStatus();
  if (info) {
    devtools.enabled = true;
    devtools.info = info;
    await installCmdListener();
    startLogPush();
  }
}

/** 仅同步展示状态（首页窗口用）：不安装命令监听器，避免重复执行命令 */
export async function syncDevToolsStatus(): Promise<void> {
  const info = await devtoolsStatus();
  devtools.enabled = !!info;
  devtools.info = info;
}

async function installCmdListener(): Promise<void> {
  if (unlistenCmd) return;
  unlistenCmd = await listen<CmdPayload>("devtools:cmd", (e) => {
    void execute(e.payload);
  });
}

interface CmdPayload {
  id: unknown;
  method: string;
  params: unknown;
  replyToken: string;
}

async function execute(cmd: CmdPayload): Promise<void> {
  try {
    // 工具权限门控：devtools.stop / ping / mcp.listTools 等未登记方法不受限制
    if (!isToolAllowed(cmd.method)) {
      const id = methodToolId(cmd.method);
      const name = devtools.tools.find((t) => t.id === id)?.name ?? id;
      throw new Error(`工具「${name}」未启用（可在首页 开发者服务 中开启）`);
    }
    // handlers 惰性加载：handlers→commands→EditorEngine→three 的静态链会把
    // 整个编辑器引擎（约 1.3MB）拖进首页窗口的首屏包。命令执行只在编辑器
    // 窗口发生，首页仅做启停/状态展示，永远触不到这条 import。
    const { handleMethod } = await import("./handlers");
    const result = await handleMethod(cmd.method, cmd.params);
    await api.devtoolsReply(cmd.replyToken, result, null);
  } catch (err: any) {
    await api.devtoolsReply(cmd.replyToken, null, String(err?.message ?? err));
  }
}

/** 把控制台新增日志推送给控制端（只推新增，避免开局刷历史） */
function startLogPush(): void {
  if (logWatchStarted) return;
  logWatchStarted = true;
  let last = logStore.lines.length;
  watch(
    () => logStore.lines.length,
    () => {
      const arr = logStore.lines;
      if (arr.length > last) {
        for (let i = last; i < arr.length; i++) void push("log", arr[i]);
        last = arr.length;
      }
    },
  );
}

/** 把一条事件推送给所有控制端（静默失败：未启用 / 无客户端时忽略） */
async function push(event: string, data: unknown): Promise<void> {
  if (!devtools.enabled) return;
  try {
    await api.devtoolsPush(event, data);
  } catch {
    /* ignore */
  }
}
