// 助手流式传输：Tauri 事件流（ai:chunk / ai:done / ai:error）封装。
// 从 agent.ts 拆出：传输层与决策循环解耦；onReqId 回调把请求 id 交还调用方，
// 供「停止」按钮调 aiCancel 终止在途流。收尾事件驱动：done/error 监听器直接
// settle 一个 Promise（不再 50ms 轮询），300s 兜底超时防事件丢失无限等待。

import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/api";
import type { ChatFn, ToolCall } from "./agent";

/** 思考参数（供应商设置下发；default = 不传参跟随模型默认） */
export interface ThinkingCfg {
  mode: "default" | "on" | "off";
  effort: "low" | "medium" | "high" | "xhigh";
}

export function createTauriTransport(
  onReqId?: (reqId: string) => void,
  thinking?: ThinkingCfg,
): ChatFn {
  return async (args) => {
    const reqId = `r_${Date.now().toString(36)}${Math.floor(Math.random() * 1e8).toString(36)}`;
    onReqId?.(reqId);
    let content = "";
    let reasoning = "";
    const calls = new Map<number, ToolCall & { argsBuf: string }>();
    let error: string | null = null;
    // done → resolve；error/超时 → reject（重复 settle 是无操作）
    let settle!: (ok: boolean) => void;
    const finished = new Promise<void>((resolve, reject) => {
      settle = (ok) => {
        if (ok) resolve();
        else reject(new Error(error ?? "未知错误"));
      };
    });

    const offChunk = await listen("ai:chunk", (e) => {
      const p = e.payload as { reqId?: string; delta?: string; reasoning?: string; toolCalls?: unknown };
      if (p.reqId !== reqId) return;
      if (typeof p.delta === "string" && p.delta) {
        content += p.delta;
        args.onDelta?.(content);
      }
      // 思考通道：与正文同事件不同字段，本轮内聚合为全文回调
      if (typeof p.reasoning === "string" && p.reasoning) {
        reasoning += p.reasoning;
        args.onReasoning?.(reasoning);
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
      if ((e.payload as { reqId?: string }).reqId === reqId) settle(true);
    });
    const offError = await listen("ai:error", (e) => {
      const p = e.payload as { reqId?: string; message?: string };
      if (p.reqId === reqId) {
        error = p.message ?? "未知错误";
        settle(false);
      }
    });
    try {
      await api.aiChatStream({
        reqId,
        baseUrl: args.baseUrl,
        apiKey: args.apiKey,
        model: args.model,
        messages: args.messages,
        temperature: args.temperature,
        // 思考参数随请求下发（default 不传参）；方言组装在后端 ai_chat_stream
        ...(thinking && thinking.mode !== "default"
          ? { thinking: thinking.mode, thinkingEffort: thinking.effort }
          : {}),
      });
      const deadline = setTimeout(() => {
        if (error === null) error = "响应超时";
        settle(false);
      }, 300_000);
      try {
        await finished;
      } finally {
        clearTimeout(deadline);
      }
    } finally {
      offChunk();
      offDone();
      offError();
    }
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
