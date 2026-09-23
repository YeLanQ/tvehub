// ---------------------------------------------------------------------------
// 会话级运行状态：任务启动时绑定 convId，切换会话 / 切设置面板都不中断任务、
// 不丢运行视图。组件（AssistantChat）只做视图：running/busy/streaming/停止
// 令牌/审批浮动条都挂在启动任务的那个会话的 RunState 上——跨会话切换时流式
// 增量仍写回原会话（闭包捕获 run），不会画到别的会话里；切回即恢复全部视图。
// Map 常驻不清理：条目是百字节级小对象，量级 = 会话数，不值得引入失效联动。
// ---------------------------------------------------------------------------
import { reactive } from "vue";
import type { NluUnitRow } from "./NluSteps.vue";

/** 语义单元化动态块（运行中过程容器；收尾清空，历史静态块接管回放） */
export interface RunNlu {
  traces: Array<{ stage: string; detail: string }>;
  units: NluUnitRow[];
  /** 本任务 brain.decompose 的 toolCallId：运行中时间线据此只隐藏当前任务
   *  的静态消息对（由末尾动态块代展），先前任务的大脑块照常保留在会话 */
  callId?: string;
}

/** 黄灯写操作确认队列项：同批并行调用的多个请求合并为一次裁决 */
export interface ExecConfirmReq {
  method: string;
  reason: string;
  resolve: (ok: boolean) => void;
}

export interface RunState {
  /** 任务执行中（同会话互斥：busy 时本会话禁止再发送） */
  busy: boolean;
  /** 流式增量净化文本（本会话气泡显示用） */
  streamingText: string;
  /** 模型思考过程（本轮 LLM 调用内聚合；单行滚动条显示，收尾清空） */
  reasoningText: string;
  /** 在途流式请求 id（「停止」按钮调 aiCancel 终止用） */
  reqId: string;
  /** 停止标记：轮边界生效 */
  stopRequested: boolean;
  /** 助手等待用户确认计划（needConfirm 浮动条） */
  pendingConfirm: boolean;
  /** 本任务原文（大脑决策中心审批会话的键） */
  lastTask: string;
  /** 大脑语义单元化动态块 */
  nluRun: RunNlu | null;
  /** 黄灯写操作确认队列 */
  execConfirms: ExecConfirmReq[];
}

const runs = reactive(new Map<string, RunState>());

function create(): RunState {
  return {
    busy: false,
    streamingText: "",
    reasoningText: "",
    reqId: "",
    stopRequested: false,
    pendingConfirm: false,
    lastTask: "",
    nluRun: null,
    execConfirms: [],
  };
}

/** 取会话的运行态（无则建空态；返回的是响应式对象，模板可直接绑定） */
export function getRun(convId: string): RunState {
  let r = runs.get(convId);
  if (!r) {
    r = create();
    runs.set(convId, r);
  }
  return r;
}
