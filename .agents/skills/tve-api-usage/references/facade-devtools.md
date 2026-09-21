# 单元：调试/devtools/局域网共享 IPC（`src/lib/api.ts`）

## 契约

**调试基础**：

| 方法 | 用途 |
|---|---|
| `appendDebugLog(line)` | 追加一行到应用配置目录 debug.log（GUI 白屏时仍可读） |
| `openDevtools()` | 打开 WebView 开发者工具（发行构建返回错误提示） |
| `devAppDirs()` → `[名称, 路径][]` | 应用相关目录（展示 + opener 打开） |

**开发者服务**（控制服务器 + MCP，前端包装在 `src/app/lib/devtools/`）：
`devtoolsStart(port?)` → `DevToolsInfo`（幂等，port 0/缺省=随机）、`devtoolsStop()`、
`devtoolsStatus()` → `DevToolsInfo|null`、`devtoolsTools()` → `DevToolPermInfo[]`、
`devtoolsSetTool(id, enabled)`、`devtoolsReply(token, result, error)`（命令结果回填）、
`devtoolsPush(event, data)`（事件广播给所有控制端）、`devtoolsRecentCalls()` →
`DevCallLogEntry[]`（最近 50 条工具调用，助手内部桥 + 控制端 TCP/MCP 统一入账）。
`DevToolsInfo { port, url, mcp_url, stdio_command, token, protocol }`（字段保持 snake_case）。
**助手内部桥与服务的关系统一**：`devtools_internal_call`（助手工具执行唯一通道）现在
要求开发者服务处于运行态——服务停用时助手调用被拒并提示开启；权限门控
（`require_tool`）对助手与控制端同一份 `devtools_perms.json`。

**局域网共享**（前端包装在 `src/app/lib/lan-share/`）：
`lanShareStatus()`（状态快照，首次顺带从盘载入）、`lanShareNetInfo()`（本机地址清单）、
`lanShareSetConfig(patch)`（补丁式，端口/网卡/口令变化重启监听）、`lanShareStart/Stop()`、
`lanSharePublishSite(req)`（托管站点整站覆盖写）、`lanShareAddDir(req)`（按引用共享目录）、
`lanShareSetEnabled(id, enabled)`、`lanShareRemove(id)`。
均返回 `LanShareStatus { config, running, port, bound, notice, urls, shares }`。

## 使用例

`src/lib/debug-log.ts:15`（调试日志双写：console + 磁盘，fire-and-forget）：

```ts
try { api.appendDebugLog(line).catch(() => {}); } catch { /* ignore */ }
```

`src/app/lib/devtools/index.ts:49`（启动开发者服务取连接信息；`:75` devtoolsStop）：

```ts
const info = await api.devtoolsStart(port);
```

`src/app/lib/lan-share/state.ts:69`（共享开关；`:79` lanShareAddDir、`:89` lanShareRemove）。

## 测试例

当前无 spec。`src/lib/debug-log.ts` 可直接测（浏览器分支不抛错 + console 落行）——
推荐写法（`src/lib/debug-log.spec.ts`，用 spy 桩而非 mock 框架）：

```ts
import { describe, expect, it, vi, afterEach } from "vitest";
import { debugLog } from "./debug-log";

afterEach(() => vi.restoreAllMocks());

describe("debugLog", () => {
  it("始终输出到 console 且不因 IPC 失败抛错（空值/异常输入）", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => debugLog("t", "hello")).not.toThrow();
    expect(spy).toHaveBeenCalledWith("[t] hello");
  });
});
```

lan-share/devtools 的状态收敛纯逻辑若要测，把纯函数拆到独立模块后按同目录 spec 补
（四类输入口径见 `tve-unit-testing` 技能）。
