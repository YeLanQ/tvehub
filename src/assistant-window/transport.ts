// 助手流式传输：Tauri 事件流（ai:chunk / ai:done / ai:error）封装。
// 从 agent.ts 拆出：传输层与决策循环解耦；onReqId 回调把请求 id 交还调用方，
// 供「停止」按钮调 aiCancel 终止在途流。

import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/api";
import type { ChatFn, ToolCall } from "./agent";

export function createTauriTransport(onReqId?: (reqId: string) => void): ChatFn {
  return async (args) => {
    const reqId = `r_${Date.now().toString(36)}${Math.floor(Math.random() * 1e8).toString(36)}`;
    onReqId?.(reqId);
    let content = "";
    const calls = new Map<number, ToolCall & { argsBuf: string }>();
    let done = false;
    let error: string | null = null;

    const offChunk = await listen("ai:chunk", (e) => {
      const p = e.payload as { reqId?: string; delta?: string; toolCalls?: unknown };
      if (p.reqId !== reqId) return;
      if (typeof p.delta === "string" && p.delta) {
        content += p.delta;
        args.onDelta?.(content);
      }
      if (Array.isArray(p.toolCalls)) {
        for (const raw of p.toolCalls as Array<Record<string, any>>) {
          const index = typeof raw.index === "number" ? raw.index : 0;
          const slot = calls.get(index) ?? { id: "", name: "", arguments: "", argsBuf: "" };
          if (typeof raw.id === "string" && raw.id) slot.id = raw.id;
          const fn = raw.function ?? {};
          if (typeof fn.name === "string" && fn.name) slot.name = fn.name;
          if (typeof fn.arguments === "string") slot.argsBuf += fn.arguments;
          calls.set(index, slot);
        }
      }
    });
    const offDone = await listen("ai:done", (e) => {
      if ((e.payload as { reqId?: string }).reqId === reqId) done = true;
    });
    const offError = await listen("ai:error", (e) => {
      const p = e.payload as { reqId?: string; message?: string };
      if (p.reqId === reqId) error = p.message ?? "未知错误";
    });
    try {
      await api.aiChatStream({
        reqId,
        baseUrl: args.baseUrl,
        apiKey: args.apiKey,
        model: args.model,
        messages: args.messages,
        temperature: args.temperature,
      });
      const deadline = Date.now() + 300_000;
      while (!done && error === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (error === null && !done) error = "响应超时";
    } finally {
      offChunk();
      offDone();
      offError();
    }
    if (error !== null) throw new Error(error);
    const toolCalls: ToolCall[] = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, c]) => ({
        id: c.id || `call_${i}`,
        name: c.name,
        arguments: c.argsBuf || "{}",
      }));
    return { content, toolCalls };
  };
}
