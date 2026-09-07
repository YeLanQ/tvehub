// devtools 方法分派 —— 适配层：远程 method 路由到命令注册表（node.* / scene.* / asset.*
// 等与编辑器 UI 共用同一命令执行路径）。命令实现见 src/app/commands/。
// mcp.listTools（协议自省）保留本地处理；参数/返回值形状与历史 devtools API 保持兼容。

import { runCommand } from "../../commands";
import { enabledMcpTools } from "./state";

/** 远程 method -> 命令 id（无匹配的方法将返回「未知方法」错误） */
const METHOD_TO_COMMAND: Record<string, string> = {
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
  "asset.delete": "asset.delete",
  "asset.rename": "asset.rename",
};

/** 远程参数 → 命令参数规整（字段名差异集中在节点删除/命名） */
function normalizeParams(method: string, params: any): any {
  switch (method) {
    case "node.remove":
      return { ids: params?.id ? [String(params.id)] : [] };
    case "node.rename":
      return {
        id: params?.id ? String(params.id) : undefined,
        name: params?.name,
      };
    default:
      // node.add 等命令读取端兼容原 devtools 字段（type/geometry/lightKind/skyKind/parentId/name）
      return params;
  }
}

/** 返回值按历史远程契约补齐（原方法大多带 ok 字段，客户端按此判断成败） */
function decorate(method: string, value: unknown): unknown {
  if (
    (method === "node.add" ||
      method === "node.remove" ||
      method === "node.rename" ||
      method === "node.select") &&
    value !== null &&
    typeof value === "object"
  ) {
    return { ok: true, ...(value as object) };
  }
  return value;
}

/** MCP 工具名规整（工具权限清单里 name 为带点方法名；此处仅供自省方法 mcp.listTools 用） */
function sanitizeMcpName(method: string): string {
  return method.replace(/\./g, "_").toLowerCase();
}

/** 方法分派：method -> 命令执行。保留 mcp.listTools 与未知方法错误语义。 */
export async function handleMethod(method: string, params: any): Promise<unknown> {
  if (method === "mcp.listTools") {
    // 与历史一致：只暴露「工具权限」中已启用工具（name 用 MCP 合法名，method 保留真实方法名）
    return enabledMcpTools().map((t) => ({
      name: sanitizeMcpName(t.name),
      method: t.name,
      description: t.description,
      inputSchema: { type: "object", properties: {} },
    }));
  }
  const cmdId = METHOD_TO_COMMAND[method];
  if (!cmdId) throw new Error(`未知方法: ${method}`);
  const value = await runCommand(cmdId, normalizeParams(method, params), { logError: false });
  return decorate(method, value);
}
