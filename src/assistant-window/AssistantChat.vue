<script setup lang="ts">
// ---------------------------------------------------------------------------
// 助手聊天主区：消息流（用户/助手/工具芯片/错误）+ 流式增量 + 输入框。
// 发送 = 组装 system(环境提示词+人设+工具+技能索引) + 历史 → 工具循环；
// @插入：资产列表选择 → asset.read 文本 → fenced 块追加进输入框。
// ---------------------------------------------------------------------------
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { toastErr } from "../ui-kit";
import { api } from "../lib/api";
import { getAssistantStore } from "./store";
import { parseFileRefs, isBinaryRef } from "./refs";
import { getConversations, type ChatMessage } from "./conversations";
import { buildSystemPrompt, doneWritesNote, looksLikeConfirmRequest, runAgent, toWire, type AgentEvent } from "./agent";
import { createTauriTransport } from "./transport";
import { streamingDisplay } from "./inline-tools";
import { mergeStepRow } from "./steps";
import { assistantTools, execAssistantTool } from "./tools";
import {
  decomposeDigest,
  parseStoredDecomposition,
  runUnitPlan,
  usablePlan,
} from "./nlu";
import { copyText } from "./clipboard";
import ToolSteps, { type ToolStepItem } from "./ToolSteps.vue";
import NluSteps, { type NluBlockData, type NluUnitRow } from "./NluSteps.vue";
import type { BrainDecomposition, BrainNluTrace, BrainTaskUnit } from "../lib/api";

const store = getAssistantStore();
const convs = getConversations();

const messages = ref<ChatMessage[]>([]);
const input = ref("");
const busy = ref(false);
const streamingText = ref("");
const scrollBox = ref<HTMLElement | null>(null);
const textEl = ref<HTMLTextAreaElement | null>(null);
/** 在途流式请求 id（终止用） */
const reqId = ref("");
const stopRequested = ref(false);
/** 已复制消息 id（按钮 ✓ 反馈） */
const copiedId = ref("");
/** 助手等待用户确认：在输入框上沿弹批准/自行输入/退出浮动条 */
const pendingConfirm = ref(false);
/** 当前任务的原文（大脑决策中心审批会话的键：批准计划时同步登记后端豁免） */
const lastTask = ref("");
/** 大脑决策中心的执行确认队列：黄灯写操作未批准时挂起等用户裁决；
 * 同轮并行调用的多个请求合并为一次批准（一次裁决全部放行/拒绝） */
interface ExecConfirmReq {
  method: string;
  reason: string;
  resolve: (ok: boolean) => void;
}
const execConfirms = ref<ExecConfirmReq[]>([]);
const execConfirmView = computed(() => execConfirms.value[0] ?? null);

// ---------------------------------------------------------------------------
// 大脑语义单元化（运行中）：发送时先经 brainDecompose 拆解——轨迹与单元任务
// 上屏过程容器（NluSteps），可用则逐单元驱动独立小循环（避免整任务长线思考），
// 不可用回落整任务直通助手。单元内的工具决策仍经决策中心（brainExecute）。
// ---------------------------------------------------------------------------
const nluRun = ref<{ traces: BrainNluTrace[]; units: NluUnitRow[] } | null>(null);
/** 单元小循环的轮上限（单元是小任务，远小于整任务的 24 轮） */
const UNIT_MAX_ROUNDS = 10;

function toNluData(deco: BrainDecomposition): { traces: BrainNluTrace[]; units: NluUnitRow[] } {
  return {
    traces: [...deco.traces],
    units: deco.units.map((u) => ({
      index: u.index,
      text: u.text,
      method: u.method,
      zone: u.zone,
      phase: u.phase,
      status: "pending" as const,
    })),
  };
}

function markUnit(index: number, status: NluUnitRow["status"]): void {
  const unit = nluRun.value?.units.find((u) => u.index === index);
  if (unit) unit.status = status;
}

/** 工具执行确认回调（注入 execAssistantTool）：入队等浮动条裁决 */
function requestToolConfirm(info: { method: string; reason: string }): Promise<boolean> {
  return new Promise((resolve) => {
    execConfirms.value.push({ ...info, resolve });
    scrollBottom();
  });
}

/** 裁决出队：同一批挂起的请求共用同一结论（批准一次覆盖同轮全部黄灯调用） */
function resolveExecConfirm(ok: boolean): void {
  const batch = execConfirms.value;
  execConfirms.value = [];
  for (const req of batch) req.resolve(ok);
}

/** 当前会话标题（首条用户消息自动命名，缺省"新会话"） */
const activeTitle = computed(() => {
  const id = convs.activeConvId();
  return convs.convs().find((c) => c.id === id)?.title ?? "新会话";
});

/** 消息时间线：连续工具消息按 toolCallId 合并为「一次调用一行」的步骤块；
 * brain.decompose 消息对合并为大脑单元化块（历史静态计划），运行中由
 * nluRun 动态块代展（两者不同时出现，收尾后动态块消失、静态块接管）。 */
type Block =
  | { kind: "msg"; key: string; m: ChatMessage }
  | { kind: "steps"; key: string; rows: ToolStepItem[] }
  | { kind: "nlu"; key: string; data: NluBlockData };

const timeline = computed<Block[]>(() => {
  const out: Block[] = [];
  const nluActive = nluRun.value != null;
  for (const m of messages.value) {
    if (m.role === "tool" && m.toolName === "brain.decompose") {
      if (nluActive) continue; // 运行中：动态块在末尾代展，避免同屏重复
      if (m.result) {
        const deco = parseStoredDecomposition(m.content);
        if (deco) {
          const data = toNluData(deco);
          const open = [...out].reverse().find((b) => b.kind === "nlu");
          if (open && open.kind === "nlu" && !open.data.units.length) {
            open.data = data; // 填充未决的调用占位块
          } else {
            out.push({ kind: "nlu", key: `nlu_r_${m.id}`, data });
          }
        }
        continue;
      }
      out.push({ kind: "nlu", key: `nlu_c_${m.toolCallId ?? m.id}`, data: { traces: [], units: [] } });
      continue;
    }
    const last = out[out.length - 1];
    if (m.role === "tool") {
      if (last && last.kind === "steps") {
        mergeStepRow(last.rows, m);
      } else {
        const rows: ToolStepItem[] = [];
        mergeStepRow(rows, m);
        out.push({ kind: "steps", key: `steps_${m.id}`, rows });
      }
    } else {
      out.push({ kind: "msg", key: m.id, m });
    }
  }
  if (nluRun.value) out.push({ kind: "nlu", key: "__nlu_run", data: nluRun.value });
  return out;
});

/** 最后一块（执行中自动展开跟随的就是它） */
const lastBlockKey = computed(() => timeline.value[timeline.value.length - 1]?.key ?? "");

const openSteps = reactive(new Set<string>());
/** 手动收起的块：优先于运行中的自动展开——否则运行中的面板点头部只是
 * 被加进 openSteps（视觉无变化），永远收不起来 */
const collapsedSteps = reactive(new Set<string>());
function stepsOpen(key: string): boolean {
  if (collapsedSteps.has(key)) return false;
  return openSteps.has(key) || (busy.value && key === lastBlockKey.value);
}
function toggleSteps(key: string): void {
  if (stepsOpen(key)) {
    openSteps.delete(key);
    collapsedSteps.add(key);
  } else {
    collapsedSteps.delete(key);
    openSteps.add(key);
  }
}

let copyTimer: ReturnType<typeof setTimeout> | undefined;
async function copyMsg(m: ChatMessage): Promise<void> {
  const ok = await copyText(m.content);
  if (!ok) {
    toastErr("复制失败：剪贴板不可用");
    return;
  }
  copiedId.value = m.id;
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => (copiedId.value = ""), 1200);
}

/** 终止：置停止标记（轮边界生效）+ 取消在途流式请求（ai:done cancelled 收尾）；
 * 挂起的执行确认一并拒绝（不再放行任何工具调用） */
async function stopGeneration(): Promise<void> {
  stopRequested.value = true;
  pendingConfirm.value = false;
  resolveExecConfirm(false);
  if (reqId.value) {
    try {
      await api.aiCancel(reqId.value);
    } catch {
      // 请求已结束：忽略
    }
  }
}

// ---------------------------------------------------------------------------
// 确认浮动条：批准 = 登记大脑审批会话 + 代发「确认」；自行输入 = 收起面板
// 并聚焦输入框；退出 = 代发取消指令让模型终止本次任务
// ---------------------------------------------------------------------------

function approveConfirm(): void {
  // 同步登记后端审批会话：本任务的黄灯调用在有效期内直接放行（豁免与
  // 代发的「确认」对应，模型重发的写操作不会被决策中心二次拦下）
  if (lastTask.value) {
    api.brainApprove(lastTask.value).catch(() => {
      // 豁免登记失败不阻塞对话：工具调用会被 needConfirm 拦下再次询问
    });
  }
  void send("确认");
}

function customInput(): void {
  pendingConfirm.value = false;
  textEl.value?.focus();
}

function cancelConfirm(): void {
  pendingConfirm.value = false;
  void send("（用户已选择退出）终止本次任务，不要再执行任何工具操作，也不要再继续。");
}

/** 输入框自增高（1 行起步，与 @/发送 同行；上限 140px） */
function autoGrow(): void {
  const el = textEl.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 140) + "px";
}

watch(input, () => void nextTick(autoGrow));

/** @插入的资产选择浮层 */
const pickerOpen = ref(false);
const pickerQuery = ref("");
const pickerList = ref<Array<{ path: string; kind: string }>>([]);
const pickerLoading = ref(false);

const card = computed(() => store.cards.find((c) => c.id === store.activeCardId) ?? null);
const provider = computed(() => store.providers.find((p) => p.id === store.activeProviderId) ?? null);
const canSend = computed(() => !busy.value && !!input.value.trim() && !!provider.value);

onMounted(async () => {
  messages.value = await convs.ensureActiveMessages();
  scrollBottom();
});

/** 文件树点文件 → 插入 @路径 引用（AssistantApp 经窗口事件投递） */
function onInsertFile(e: Event): void {
  const detail = (e as CustomEvent).detail as { path?: string };
  insertRef(detail?.path ?? "");
  scrollBottom();
}
window.addEventListener("assistant:insert-file", onInsertFile);
onBeforeUnmount(() => window.removeEventListener("assistant:insert-file", onInsertFile));

// @文件引用解析（令牌格式 / 二进制判定 / 发送时附件注入）在 ./refs 纯函数模块

/** 插入一条引用令牌（含空格的路径自动加方括号） */
function insertRef(path: string): void {
  if (!path) return;
  const token = path.includes(" ") ? `@[${path}]` : `@${path}`;
  const needSpace = input.value.length > 0 && !/\s$/.test(input.value);
  input.value += (needSpace ? " " : "") + token + " ";
  pickerOpen.value = false;
}

watch(
  () => convs.activeConvId(),
  async () => {
    pendingConfirm.value = false;
    messages.value = await convs.ensureActiveMessages();
    scrollBottom();
  },
);

watch([() => messages.value.length, streamingText], () => scrollBottom());

function scrollBottom(): void {
  void nextTick(() => {
    const box = scrollBox.value;
    if (box) box.scrollTop = box.scrollHeight;
  });
}

async function openPicker(): Promise<void> {
  pickerOpen.value = true;
  pickerQuery.value = "";
  pickerLoading.value = true;
  try {
    // 与文件树同源：显式携带当前工作区 root，无需编辑器打开项目
    const res = await execAssistantTool("asset.list", "{}", convs.activeRoot || undefined);
    if (res && typeof res === "object" && "error" in res) {
      throw new Error(String(res.error));
    }
    pickerList.value = (Array.isArray(res) ? res : []).filter(
      (a) => a.kind !== "dir",
    );
  } catch (e) {
    pickerOpen.value = false;
    toastErr(e instanceof Error ? e.message : String(e));
  } finally {
    pickerLoading.value = false;
  }
}

function filteredPicker(): Array<{ path: string; kind: string }> {
  const q = pickerQuery.value.trim().toLowerCase();
  if (!q) return pickerList.value;
  return pickerList.value.filter((a) => a.path.toLowerCase().includes(q));
}

/** 选择浮层点文件：插入引用令牌（不展开内容；内容在发送时解析） */
function insertAsset(path: string): void {
  insertRef(path);
}

/** 解析 @引用 → 附加到 wire 消息的注入块（文本全文；二进制仅文件名） */
async function resolveRefAttachments(refs: string[]): Promise<string> {
  let block = "";
  for (const ref of refs) {
    if (isBinaryRef(ref)) {
      block += `\n（引用模型/数据文件：${ref}——二进制文件，仅按文件名引用，无内容）`;
      continue;
    }
    const res = await execAssistantTool(
      "asset.read",
      JSON.stringify({ path: ref }),
      convs.activeRoot || undefined,
    );
    if (res && typeof res === "object" && "error" in res) {
      block += `\n（引用文件：${ref}——读取失败：${String(res.error)}）`;
      continue;
    }
    const doc = res as { path?: string; content?: string };
    block += `\n\n--- 文件：${doc?.path ?? ref} ---\n${doc?.content ?? ""}\n--- 结束 ---`;
  }
  return block;
}

/** 发送（textArg 供确认浮动条等程序化调用；模板 @click 必须写 send()） */
async function send(textArg?: string | Event): Promise<void> {
  const typed = typeof textArg === "string";
  const text = (typed ? textArg : input.value).trim();
  const prov = provider.value;
  if (!text || busy.value || !prov) return;
  if (!prov.baseUrl.trim() || !prov.model.trim()) {
    toastErr("请先在「设置 → 供应商」填写地址与模型");
    return;
  }
  if (!typed) input.value = "";
  pendingConfirm.value = false;
  lastTask.value = text;
  const convId = convs.activeConvId();
  if (!convId) return;
  convs.append(convId, { role: "user", content: text });
  // @引用在发送时解析：文本文件全文注入 wire（不进可见消息）
  const refs = parseFileRefs(text);
  const attachments = refs.length ? await resolveRefAttachments(refs) : "";
  const history = toWire(messages.value);
  const card0 = card.value;
  // 跨轮防重复备忘：本会话已成功的写操作（只进 wire 不落库）——跨轮历史不含
  // 工具结果，没有它模型会把往期任务并入 brain.plan 重跑（如再次 project.create）
  const note = doneWritesNote(messages.value);
  const wire = [
    { role: "system" as const, content: buildSystemPrompt(card0, convs.activeRoot) },
    // 历史末尾是刚追加的用户消息 → 替换为"原文 + 引用附件"版本
    ...history.slice(0, -1),
    ...(note ? [{ role: "user" as const, content: note }] : []),
    { role: "user" as const, content: text + attachments },
  ];
  busy.value = true;
  streamingText.value = "";
  stopRequested.value = false;
  // ---- 语义单元化：输入先过大脑（分段 → 神经图检索 → 命令预测），轨迹与
  // 单元任务上屏过程容器；拆解可用则逐单元驱动独立小循环（每单元一次小
  // agent 会话，避免整任务长线思考），不可用回落整任务直通助手 ----
  let units: BrainTaskUnit[] | null = null;
  const nluCallId = `nlu_${Date.now().toString(36)}`;
  try {
    const deco = await api.brainDecompose(text);
    nluRun.value = toNluData(deco);
    units = usablePlan(deco);
    if (!units) {
      nluRun.value.traces.push({ stage: "降级", detail: "语义信号不足，整任务直通助手" });
    }
    // 拆解过程落库：历史回放为静态大脑块（轨迹 + 单元计划）
    convs.append(convId, {
      role: "tool",
      content: text,
      toolName: "brain.decompose",
      toolCallId: nluCallId,
    });
    convs.append(convId, {
      role: "tool",
      content: decomposeDigest({
        task: deco.task,
        units: deco.units,
        traces: nluRun.value.traces,
      }),
      toolName: "brain.decompose",
      toolCallId: nluCallId,
      result: true,
    });
    scrollBottom();
  } catch {
    units = null; // 大脑不可用：静默回落，不因拆解失败阻塞对话
  }
  const agentCommon = {
    tools: assistantTools(),
    chat: createTauriTransport((id) => (reqId.value = id)),
    execTool: (name: string, argsJson: string) =>
      execAssistantTool(
        name,
        argsJson,
        convs.activeRoot || undefined,
        text,
        requestToolConfirm,
      ),
    baseUrl: prov.baseUrl,
    apiKey: prov.apiKey,
    model: card0?.model?.trim() ? card0.model.trim() : prov.model,
    temperature: card0?.temperature ?? undefined,
    onDelta: (t: string) => {
      // 流式显示走净化：完整调用块被剔除、尾部疑似调用的半截对象不闪现
      streamingText.value = streamingDisplay(t);
    },
    onEvent: (e: AgentEvent) => {
      if (e.type === "tool_start") {
        convs.append(convId, {
          role: "tool",
          content: e.args ?? "",
          toolName: e.name,
          toolCallId: e.callId,
        });
      } else if (e.type === "tool_result") {
        convs.append(convId, {
          role: "tool",
          content: e.result ?? "",
          toolName: e.name,
          toolCallId: e.callId,
          result: true,
        });
      }
    },
    shouldStop: () => stopRequested.value,
  };
  try {
    let finalText: string;
    if (units) {
      // 单元路线：逐单元独立会话；工具决策仍在 execTool 内经决策中心门控
      const result = await runUnitPlan(units, {
        runOnce: (extra) =>
          runAgent({ ...agentCommon, messages: [...wire, ...extra], maxRounds: UNIT_MAX_ROUNDS }),
        onUnitStart: (index) => markUnit(index, "running"),
        onUnitDone: (index, note) => {
          markUnit(index, "ok");
          convs.append(convId, { role: "assistant", content: note.trim() || "（本单元无输出）" });
        },
        shouldStop: agentCommon.shouldStop,
      });
      finalText = result.reply.content.trim();
      if (result.stopped) {
        convs.append(convId, { role: "assistant", content: finalText });
      }
    } else {
      const reply = await runAgent({ ...agentCommon, messages: wire });
      // 空回复兜底：绝不让一轮运行无声无息地结束
      finalText =
        reply.content.trim() ||
        "（模型这一轮返回了空回复。回复「继续」让它接着执行；若反复出现，请检查供应商返回内容。）";
      convs.append(convId, { role: "assistant", content: finalText });
    }
    // 请求确认 → 输入框上沿弹批准/自行输入/退出浮动条
    pendingConfirm.value = !stopRequested.value && looksLikeConfirmRequest(finalText);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    convs.append(convId, { role: "error", content: msg });
    toastErr(msg);
  } finally {
    busy.value = false;
    streamingText.value = "";
    reqId.value = "";
    nluRun.value = null; // 动态块退场：历史静态大脑块接管回放
    // messages.value 必须与 conversations 缓存数组保持同一引用：convs.append
    // 推的是缓存数组，此处若换成浅拷贝副本，时间线 computed 将收不到触发——
    // 下一轮的用户消息与工具步骤在运行期间全部"消失"（只剩流式气泡），
    // 直到本轮收尾才一次性冒出来。
    messages.value = await convs.ensureActiveMessages();
    scrollBottom();
  }
}

function onInputKey(e: KeyboardEvent): void {
  if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  void send();
}

/** 会话新建入口在左栏项目条目的悬停 ＋（newConvIn），本组件不再持有 */
</script>

<template>
  <div class="achat">
    <div class="achat-head">
      <span class="achat-card" :title="card?.persona">{{ card?.name ?? "未选卡片" }}</span>
      <span class="achat-conv">{{ activeTitle }}</span>
    </div>

    <div ref="scrollBox" class="achat-scroll">
      <p v-if="!provider" class="achat-guide">
        还没有配置模型供应商：点左下角「⚙ 设置」→ 供应商，填写 OpenAI 兼容地址与
        API Key 即可开始。
      </p>
      <template v-for="b in timeline" :key="b.key">
      <ToolSteps
        v-if="b.kind === 'steps'"
        :items="b.rows"
        :open="stepsOpen(b.key)"
        :running="busy && b.key === lastBlockKey"
        @toggle="toggleSteps(b.key)"
      />
      <NluSteps
        v-else-if="b.kind === 'nlu' && (b.data.units.length || (busy && b.key === lastBlockKey))"
        :data="b.data"
        :open="stepsOpen(b.key)"
        :running="busy && b.key === lastBlockKey"
        @toggle="toggleSteps(b.key)"
      />
        <div
          v-else-if="b.kind === 'msg' && b.m.role === 'error'"
          class="achat-bubble achat-bubble-error"
        >{{ b.m.content }}</div>
        <div v-else-if="b.kind === 'msg'" class="achat-row" :class="b.m.role">
          <div class="achat-bubble">
            <span class="achat-content">{{ b.m.content }}</span>
            <button
              class="achat-copy"
              :title="copiedId === b.m.id ? '已复制' : '复制'"
              @click="copyMsg(b.m)"
            >{{ copiedId === b.m.id ? "✓" : "⧉" }}</button>
          </div>
        </div>
      </template>
      <div v-if="busy" class="achat-row assistant">
        <div v-if="streamingText" class="achat-bubble">{{ streamingText }}▌</div>
        <div v-else class="achat-bubble achat-typing"><i /><i /><i /></div>
      </div>
    </div>

    <!-- 确认浮动条：助手请求确认时贴合在输入框上沿 -->
    <div v-if="pendingConfirm && !busy" class="achat-confirm">
      <span class="achat-confirm-text">助手请求确认，以继续执行待确认的操作</span>
      <div class="achat-confirm-actions">
        <button class="achat-confirm-btn ok" title="回复「确认」并继续执行" @click="approveConfirm()">
          批准
        </button>
        <button class="achat-confirm-btn" title="收起面板，自行输入回复" @click="customInput()">
          自行输入
        </button>
        <button class="achat-confirm-btn bad" title="终止本次任务" @click="cancelConfirm()">
          退出
        </button>
      </div>
    </div>

    <!-- 执行确认浮动条：大脑决策中心对黄灯写操作挂起等用户裁决（运行中可见） -->
    <div v-if="execConfirmView" class="achat-confirm">
      <span class="achat-confirm-text" :title="execConfirmView.reason">
        大脑请求确认：执行「{{ execConfirmView.method }}」（写操作）——{{ execConfirmView.reason }}
      </span>
      <div class="achat-confirm-actions">
        <button
          class="achat-confirm-btn ok"
          title="批准本次任务的写操作（后续同类调用不再逐个询问）"
          @click="resolveExecConfirm(true)"
        >
          批准并执行
        </button>
        <button
          class="achat-confirm-btn bad"
          title="拒绝执行，助手会收到拒绝回执"
          @click="resolveExecConfirm(false)"
        >
          拒绝
        </button>
      </div>
    </div>

    <div class="achat-input" :class="{ joined: pendingConfirm && !busy }">
      <textarea
        ref="textEl"
        v-model="input"
        class="achat-text"
        rows="1"
        placeholder="Enter 发送，Shift+Enter 换行"
        @keydown="onInputKey"
      />
      <div class="achat-toolbar">
        <!-- @ 引用是工作区功能：通用会话（未绑定项目）没有可列/可读的项目文件，
             按钮不渲染，也就不会触发「没有工作区项目」的选择浮层报错 -->
        <button v-if="convs.activeRoot" class="achat-at" title="插入项目文件" :disabled="busy" @click="openPicker">@</button>
        <span class="achat-hint">Enter 发送 · Shift+Enter 换行</span>
        <button v-if="busy" class="achat-send stop" title="终止执行" @click="stopGeneration">
          停止
        </button>
        <button v-else class="achat-send" :disabled="!canSend" @click="send()">发送</button>
      </div>
    </div>

    <div v-if="pickerOpen" class="achat-picker" @click.self="pickerOpen = false">
      <div class="achat-picker-box">
        <div class="achat-picker-head">
          <span>插入项目文件（文本）</span>
          <button @click="pickerOpen = false">×</button>
        </div>
        <input v-model="pickerQuery" class="achat-picker-q" placeholder="搜索路径…" />
        <div class="achat-picker-list">
          <button
            v-for="a in filteredPicker()"
            :key="a.path"
            class="achat-picker-item"
            :title="a.path"
            @click="insertAsset(a.path)"
          >
            <b>{{ a.kind }}</b> {{ a.path }}
          </button>
          <p v-if="pickerLoading" class="achat-picker-empty">读取中…</p>
          <p v-else-if="!filteredPicker().length" class="achat-picker-empty">无匹配</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.achat { display: flex; flex-direction: column; flex: 1; min-height: 0; position: relative; }
.achat-head {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; border-bottom: 1px solid var(--border); flex: none;
  .achat-card { color: var(--text); font-weight: 600; }
  .achat-conv { flex: 1; min-width: 0; font-size: 12px; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
}
.achat-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 10px; user-select: text; }
.achat-guide { color: var(--text-dim); background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; padding: 10px; }
.achat-row { display: flex; margin: 6px 0; &.user { justify-content: flex-end; } }
.achat-bubble {
  position: relative;
  max-width: 88%; padding: 7px 28px 7px 10px; border-radius: 10px;
  background: var(--bg-hover); word-break: break-word;
  .user & { background: var(--bg-active); }
  &:hover .achat-copy { opacity: 1; }
}
.achat-content { white-space: pre-wrap; user-select: text; cursor: text; }
.achat-copy {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 20px;
  height: 20px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-dim);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s;
  &:hover { background: var(--bg-hover); color: var(--text); }
}
.achat-bubble-error { border: 1px solid var(--err); color: var(--err); border-radius: 10px; padding: 7px 10px; margin: 6px 0; white-space: pre-wrap; user-select: text; }
.achat-typing { display: inline-flex; gap: 4px; i { width: 6px; height: 6px; border-radius: 50%; background: var(--text-dim); animation: atyp 1s infinite; &:nth-child(2) { animation-delay: 0.15s; } &:nth-child(3) { animation-delay: 0.3s; } } }
@keyframes atyp { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }
.achat-input {
  display: flex;
  flex-direction: column;
  margin: 8px 10px 10px;
  padding: 8px 8px 6px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-input);
  flex: none;
  &:focus-within { border-color: var(--accent); }
  &.joined {
    margin-top: 0;
    border-radius: 0 0 12px 12px;
  }
}
.achat-confirm {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 10px 0;
  padding: 7px 10px;
  border: 1px solid var(--accent);
  border-bottom: none;
  border-radius: 12px 12px 0 0;
  background: var(--bg-input);
  flex: none;
}
.achat-confirm-text { flex: 1; min-width: 0; font-size: 12px; color: var(--text); }
.achat-confirm-actions { display: flex; gap: 6px; flex: none; }
.achat-confirm-btn {
  height: 26px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
  &:hover { background: var(--bg-hover); }
  &.ok { border-color: var(--ok); color: var(--ok); &:hover { background: var(--ok); color: var(--bg); } }
  &.bad { border-color: var(--err); color: var(--err); &:hover { background: var(--err); color: var(--bg); } }
}
.achat-text {
  resize: none;
  max-height: 140px;
  border: none;
  background: transparent;
  color: var(--text);
  padding: 2px 4px;
  font: inherit;
  line-height: 1.5;
  &:focus { outline: none; }
}
.achat-toolbar { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
.achat-hint { flex: 1; font-size: 11px; color: var(--text-dim); opacity: 0.75; }
.achat-at {
  flex: none;
  width: 26px;
  height: 26px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  &:hover { background: var(--bg-hover); color: var(--text); }
  &:disabled { opacity: 0.5; }
}
.achat-send { flex: none; height: 28px; border: none; border-radius: 6px; background: var(--btn); color: var(--text); padding: 0 14px; cursor: pointer;
  &:hover { background: var(--btn-hover); }
  &:disabled { opacity: 0.45; cursor: default; }
  &.stop {
    background: transparent;
    border: 1px solid var(--err);
    color: var(--err);
    opacity: 1;
    cursor: pointer;
    &:hover { background: var(--err); color: var(--bg); }
  } }
.achat-picker { position: fixed; inset: 0; background: rgb(0 0 0 / 0.45); display: flex; align-items: center; justify-content: center; }
.achat-picker-box { width: 82%; max-height: 70%; display: flex; flex-direction: column; background: var(--bg-panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px; }
.achat-picker-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; color: var(--text); button { border: none; background: transparent; color: var(--text-dim); font-size: 16px; cursor: pointer; } }
.achat-picker-q { border: 1px solid var(--border); border-radius: 6px; background: var(--bg-input); color: var(--text); padding: 6px 8px; margin-bottom: 8px; }
.achat-picker-list { overflow-y: auto; min-height: 120px; display: flex; flex-direction: column; gap: 2px; }
.achat-picker-item { border: none; background: transparent; color: var(--text); text-align: left; padding: 5px 8px; border-radius: 6px; cursor: pointer; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; b { color: var(--text-dim); font-weight: 400; margin-right: 6px; } &:hover { background: var(--bg-hover); } }
.achat-picker-empty { color: var(--text-dim); margin: 8px; }
</style>
