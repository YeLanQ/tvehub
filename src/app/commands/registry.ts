// 命令注册表与执行器：
// - registerCommand：全局唯一注册（命令在模块导入时自注册，入口 import index 即全量注册）；
// - dispatchCommand：统一入口——可用性判定 → 执行 → 结构化结果；失败写入控制台；
// - runCommand：需要异常语义的适配层（组件 await、devtools/MCP 回错误）使用。
//
// devtools / MCP 不再维护第二套实现：方法分派映射到命令 id 后走同一执行器（见 devtools 适配）。

import { logStore } from "../stores/log";
import { createContext } from "./context";
import type { CommandResult, EditorCommand } from "./types";

const commandMap = new Map<string, EditorCommand<any>>();

/** 注册一条命令（重复 id 记 warning 并覆盖，便于热替换） */
export function registerCommand<A = unknown>(cmd: EditorCommand<A>): void {
  if (commandMap.has(cmd.id)) {
    console.warn(`[commands] 重复注册命令: ${cmd.id}`);
  }
  commandMap.set(cmd.id, cmd);
}

/** 按 id 取命令定义 */
export function getCommand(id: string): EditorCommand<any> | undefined {
  return commandMap.get(id);
}

export function hasCommand(id: string): boolean {
  return commandMap.has(id);
}

/** 全部已注册命令（按注册顺序；注册表驱动 工具权限/MCP 清单） */
export function listCommands(): EditorCommand<any>[] {
  return [...commandMap.values()];
}

export interface DispatchOptions {
  /** 执行失败时是否写入控制台（logStore），默认 true */
  logError?: boolean;
}

/** 统一命令执行入口：canRun 不满足 → { skipped }；运行时错误 → { error }（不抛） */
export async function dispatchCommand(
  id: string,
  args?: unknown,
  opts: DispatchOptions = {},
): Promise<CommandResult> {
  const cmd = commandMap.get(id);
  if (!cmd) return { ok: false, error: `未知命令: ${id}` };
  const ctx = createContext();
  if (cmd.canRun && !cmd.canRun(ctx)) return { ok: false, skipped: true };
  try {
    const value = await cmd.run(ctx, args);
    return value === undefined ? { ok: true } : { ok: true, value };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (opts.logError !== false) logStore.log("error", `[${cmd.label}] ${error}`, "command");
    return { ok: false, error };
  }
}

/** 需要异常语义的调用（组件 await、devtools/MCP 把 error 回给客户端）：
 *  成功返回 run 值；不可用/失败抛 Error（skipped 视为成功但返回 undefined） */
export async function runCommand(id: string, args?: unknown, opts?: DispatchOptions): Promise<unknown> {
  const r = await dispatchCommand(id, args, opts);
  if (!r.ok) {
    if (r.skipped) return undefined;
    throw new Error(r.error || `命令执行失败: ${id}`);
  }
  return r.value;
}
