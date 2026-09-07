// devtools 拆解 —— devtools-format：开发者服务/MCP 面板的纯数据构造。
// 分组展示、端点/配置 JSON 生成不依赖 Vue；HomeView 只做参数装配与复制动作。

import { type DevToolsInfo, DEVTOOLS_DEFAULT_PORT } from "./state";

export interface DevToolRow {
  id: string;
  name: string;
  enabled: boolean;
}

/** 工具权限按 group 分组展示（保序） */
export function groupDevToolsTools(tools: {
  group: string;
  id: string;
  name: string;
  enabled: boolean;
}[]): { group: string; tools: DevToolRow[] }[] {
  const groups: { group: string; tools: DevToolRow[] }[] = [];
  for (const t of tools) {
    let g = groups.find((x) => x.group === t.group);
    if (!g) {
      g = { group: t.group, tools: [] };
      groups.push(g);
    }
    g.tools.push({ id: t.id, name: t.name, enabled: t.enabled });
  }
  return groups;
}

/** MCP HTTP 端点（与应用 devtools 同一端口） */
export function mcpEndpointOf(info: DevToolsInfo | null, port: number): string {
  return info?.mcp_url ?? `http://127.0.0.1:${port > 0 ? port : DEVTOOLS_DEFAULT_PORT}/mcp`;
}

/** MCP stdio 桥程序路径（mcp.exe，与主程序同目录；未启用服务时回退裸文件名） */
export function mcpStdioCommandOf(info: DevToolsInfo | null): string {
  return info?.stdio_command ?? "mcp.exe";
}

/** MCP 服务配置 JSON（streamable-http：服务名 + 端点 URL，同一端口） */
export function mcpConfigJson(endpoint: string): string {
  return JSON.stringify({ mcpServers: { "tve-devtools": { url: endpoint } } }, null, 2);
}

/** MCP 服务配置 JSON（stdio：客户端拉起 mcp.exe 子进程，--port 转发到 devtools TCP） */
export function mcpStdioConfigJson(command: string, port: number): string {
  return JSON.stringify(
    {
      mcpServers: {
        "tve-devtools": {
          command,
          args: ["--port", String(port > 0 ? port : DEVTOOLS_DEFAULT_PORT)],
        },
      },
    },
    null,
    2,
  );
}
