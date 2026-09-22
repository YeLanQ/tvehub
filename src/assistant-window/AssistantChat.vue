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
import { buildFileTocBlock, shouldIndexInstead, type FileIndexBrief } from "./fileidx";
import { getConversations, type ChatMessage } from "./conversations";
import {
  buildSystemPrompt,
  CALLS_PLACEHOLDER,
  doneWritesNote,
  looksLikeConfirmRequest,
  runAgent,
  toWire,
  type AgentEvent,
} from "./agent";
import { hasLabeledCallTrace } from "./labeled-calls";
import { createTauriTransport } from "./transport";
import { streamingDisplay } from "./inline-tools";
import { mergeStepRow } from "./steps";
import { assistantTools, execAssistantTool } from "./tools";
import {
  decomposeDigest,
  knowledgeNote,
  parseStoredDecomposition,
  planNote,
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

function toNluData(deco: BrainDecomposition): { traces: BrainNluTrace[]; units: NluUnitRow[] } {
  return {
    traces: [...deco.traces],
    units: deco.units.map((u) => ({
      index: u.index,
      text: u.text,
      method: u.method,
      zone: u.zone,
      phase: u.phase,
      refs: u.refs ?? [],
      exec: u.exec,
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
/** 手动收起的块：优先于手动展开集合——面板默认收敛一行（不再随运行自动
 * 展开，展开后内容区内部滚动），展开/收起完全由用户点击头部驱动 */
const collapsedSteps = reactive(new Set<string>());
function stepsOpen(key: string): boolean {
  return openSteps.has(key) && !collapsedSteps.has(key);
}
function toggleSteps(key: string): void {
  if (stepsOpen(key)) {
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

// ---------------------------------------------------------------------------
// 工具调用信息气泡：调用占位 / 标签方言调用 / 结果转储这类消息默认收敛成
// 单行（无滚动条，滚轮左右平移），右侧箭头图标，点击向下展开全文、再点收起
// ---------------------------------------------------------------------------

/** 结果转储开头：整条消息以「结果：」类标签起头 */
const RESULT_DUMP_RE =
  /^[ \t]*(?:\*\*|__|\[|【)?[ \t]*(?:执行结果|调用结果|运行结果|返回结果|结果|输出|result|output)[ \t]*(?:\*\*|__|\]|\)|】)?[ \t]*[:：]/;

function isToolCallInfo(m: ChatMessage): boolean {
  if (m.role !== "assistant") return false;
  const t = m.content.trim();
  if (!t) return false;
  return t === CALLS_PLACEHOLDER || hasLabeledCallTrace(t) || RESULT_DUMP_RE.test(t);
}

/** 展开状态（按消息 id）；展开 = 向下铺开全文，收敛 = 单行裁剪 */
const toolInfoOpen = reactive(new Set<string>());
function toolInfoIsOpen(m: ChatMessage): boolean {
  return toolInfoOpen.has(m.id);
}
function toggleToolInfo(m: ChatMessage): void {
  if (toolInfoOpen.has(m.id)) toolInfoOpen.delete(m.id);
  else toolInfoOpen.add(m.id);
}

/** 收敛态滚轮左右平移（overflow:hidden 无滚动条，纵向滚轮转横向位移）；
 * 展开态交还竖向滚动 */
function wheelToolInfo(e: WheelEvent): void {
  const el = e.currentTarget as HTMLElement;
  if (el.classList.contains("open")) return;
  e.preventDefault();
  el.scrollLeft += e.deltaY;
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

/** @插入的资产选择浮层（锚定输入框上方的 popover）。
 *  两种打开方式：button = 点 @ 按钮自由搜索；inline = 输入框敲 @ 实时补全
 *  （搜索词跟随 @token，↑/↓/Enter/Esc 在 textarea 键盘拦截，焦点不离开输入框） */
const pickerOpen = ref(false);
const pickerQuery = ref("");
const pickerList = ref<Array<{ path: string; kind: string }>>([]);
const pickerLoading = ref(false);
/** 键盘可达：↑/↓ 移动高亮、Enter 选中、Esc 关闭 */
const pickerQEl = ref<HTMLInputElement | null>(null);
const pickerSel = ref(0);
const pickerMode = ref<"button" | "inline">("button");
/** inline 模式下 @token 在输入框中的起始位置（选中后整段替换） */
const atFrom = ref(-1);
// 搜索词变化后高亮回到首项，避免 ↑/↓ 停在已被过滤掉的行
watch(pickerQuery, () => {
  pickerSel.value = 0;
});

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

/** 插入一条引用令牌（含空格的路径自动加方括号）。
 *  from 提供时为 inline 补全：替换输入框 [from, 光标) 的 @token 片段，光标落到插入末尾 */
function insertRef(path: string, from?: number): void {
  if (!path) return;
  const token = path.includes(" ") ? `@[${path}]` : `@${path}`;
  if (from != null && from >= 0) {
    const el = textEl.value;
    const cursor = el?.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, from) + token + " " + input.value.slice(cursor);
    void nextTick(() => {
      if (el) {
        const pos = from + token.length + 1;
        el.setSelectionRange(pos, pos);
        el.focus();
      }
    });
  } else {
    const needSpace = input.value.length > 0 && !/\s$/.test(input.value);
    input.value += (needSpace ? " " : "") + token + " ";
  }
  pickerOpen.value = false;
  atFrom.value = -1;
}

watch(
  () => convs.activeConvId(),
  async () => {
    pendingConfirm.value = false;
    pickerOpen.value = false;
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

/** 拉取工作区资产清单（浮层两种打开方式共用；与文件树同源：无需编辑器打开项目） */
async function loadPickerList(): Promise<void> {
  pickerLoading.value = true;
  try {
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

/** 点 @ 按钮：自由搜索模式 */
async function openPicker(): Promise<void> {
  pickerMode.value = "button";
  atFrom.value = -1;
  pickerOpen.value = true;
  pickerQuery.value = "";
  pickerSel.value = 0;
  void nextTick(() => pickerQEl.value?.focus());
  if (!pickerList.value.length) await loadPickerList();
}

/**
 * 输入框 @ 语法实时补全：光标左侧是「行首/空白 + @ + 无空白 token」时打开
 * 浮层（搜索词跟随 token），token 打空格/删除 @ 即收起。input/keyup/click
 * 都会重估（覆盖输入、方向键移光标、点选光标三种路径）。
 */
function updateAtState(): void {
  const el = textEl.value;
  if (!el || !convs.activeRoot) return;
  const before = input.value.slice(0, el.selectionStart ?? input.value.length);
  const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (m) {
    const changed = !pickerOpen.value || pickerMode.value !== "inline";
    pickerMode.value = "inline";
    atFrom.value = (el.selectionStart ?? input.value.length) - m[1].length - 1;
    pickerQuery.value = m[1];
    if (changed) {
      pickerSel.value = 0;
      pickerOpen.value = true;
      if (!pickerList.value.length && !pickerLoading.value) void loadPickerList();
    }
  } else if (pickerOpen.value && pickerMode.value === "inline") {
    pickerOpen.value = false;
    atFrom.value = -1;
  }
}

function filteredPicker(): Array<{ path: string; kind: string }> {
  const q = pickerQuery.value.trim().toLowerCase();
  if (!q) return pickerList.value;
  return pickerList.value.filter((a) => a.path.toLowerCase().includes(q));
}

/** 选择浮层点文件：插入引用令牌（不展开内容；内容在发送时解析）。
 *  inline 补全模式替换 @token 片段，按钮模式追加到末尾 */
function insertAsset(path: string): void {
  insertRef(path, pickerMode.value === "inline" ? atFrom.value : undefined);
  textEl.value?.focus();
}

/** 关闭浮层并把焦点还给输入框 */
function closePicker(): void {
  pickerOpen.value = false;
  atFrom.value = -1;
  textEl.value?.focus();
}

/** ↑/↓ 移动高亮（循环）；Enter 选中当前高亮项 */
function movePickerSel(delta: number): void {
  const n = filteredPicker().length;
  if (!n) return;
  pickerSel.value = (pickerSel.value + delta + n) % n;
}

function pickPickerSel(): void {
  const item = filteredPicker()[pickerSel.value];
  if (item) insertAsset(item.path);
}

/** 大文件索引注入：file.index 建索引取模块目录；失败回退整包全文（降级不丢内容） */
async function buildIndexedBlock(ref: string, fallbackContent?: string): Promise<string> {
  const res = await execAssistantTool(
    "file.index",
    JSON.stringify({ path: ref }),
    convs.activeRoot || undefined,
  );
  if (res && typeof res === "object" && !("error" in res)) {
    return buildFileTocBlock(ref, res as FileIndexBrief);
  }
  const reason =
    res && typeof res === "object" && "error" in res ? String(res.error) : "未知错误";
  if (fallbackContent != null) {
    return `\n\n--- 文件：${ref}（索引失败：${reason}，回退全文注入） ---\n${fallbackContent}\n--- 结束 ---`;
  }
  return `\n（引用文件：${ref}——索引失败：${reason}）`;
}

/** 解析 @引用 → 附加到 wire 消息的注入块：小文件全文；大文件索引目录+
 * 按需 file.search；二进制仅文件名 */
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
      // 超 512KB 拒读的大文件：跳过整读转索引模式（索引侧上限 2MB）
      if (shouldIndexInstead(undefined, undefined, String(res.error))) {
        block += await buildIndexedBlock(ref);
        continue;
      }
      block += `\n（引用文件：${ref}——读取失败：${String(res.error)}）`;
      continue;
    }
    const doc = res as { path?: string; content?: string; truncated?: boolean };
    if (shouldIndexInstead(doc?.content, doc?.truncated)) {
      block += await buildIndexedBlock(ref, doc?.content);
      continue;
    }
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
  // 单元任务上屏过程容器；绿色通道（死板过程命令）大脑直执行，模糊原子任务
  // 合并为一次助手会话按计划推进，纯对话/指令任务直通 ----
  let assistUnits: BrainTaskUnit[] = [];
  const directResults: string[] = [];
  /** 直通/计划路线的知识注入 */
  let brainNote = "";
  let directNote = "";
  let deco: BrainDecomposition | null = null;
  const nluCallId = `nlu_${Date.now().toString(36)}`;
  try {
    deco = await api.brainDecompose(text, convs.activeRoot || undefined);
    nluRun.value = toNluData(deco);
    // 绿色通道（死板过程命令）：大脑直接委托命令中心执行，不经助手；
    // 模糊原子任务留给助手按计划转换。全走 brain_execute 门控与观测闭环。
    for (const u of deco.units.filter((x) => x.exec === "direct" && x.method)) {
      if (stopRequested.value) break; // 停止：剩余直执行单元不再发起
      markUnit(u.index, "running");
      convs.append(convId, {
        role: "tool",
        content: JSON.stringify(u.params ?? {}),
        toolName: u.method!,
        toolCallId: `d_${u.index}`,
      });
      let ok = false;
      let digest = "";
      try {
        // 绿色通道仅死板过程命令（无参绿灯查询）：仍经决策中心门控与观测
        const res = await execAssistantTool(
          u.method!,
          JSON.stringify(u.params ?? {}),
          convs.activeRoot || undefined,
          text,
          requestToolConfirm,
        );
        const err = (res as { error?: unknown } | null)?.error;
        ok = !err;
        digest = JSON.stringify(res);
      } catch (e) {
        digest = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
      }
      markUnit(u.index, ok ? "ok" : "fail");
      convs.append(convId, {
        role: "tool",
        content: digest.slice(0, 2000),
        toolName: u.method!,
        toolCallId: `d_${u.index}`,
        result: true,
      });
      directResults.push(
        `- ${u.method}(${JSON.stringify(u.params ?? {})}) → ${ok ? "完成" : "失败"}：${digest.length > 160 ? digest.slice(0, 160) + "…" : digest}`,
      );
    }
    directNote = directResults.length
      ? "（系统·大脑原子执行）以下只读原子任务已由大脑直接完成，不要重复执行，直接引用其结果：\n" +
        directResults.join("\n")
      : "";
    assistUnits = deco.units.filter((u) => u.exec !== "direct");
    if (!assistUnits.length) {
      nluRun.value.traces.push(
        directResults.length
          ? { stage: "零调用", detail: "任务已由大脑原子执行完成，无需助手" }
          : { stage: "直通", detail: "纯对话/指令任务，直通助手" },
      );
      brainNote = knowledgeNote(deco);
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
        refs: deco.refs,
      }),
      toolName: "brain.decompose",
      toolCallId: nluCallId,
      result: true,
    });
    scrollBottom();
  } catch {
    assistUnits = []; // 大脑不可用：静默回落，不因拆解失败阻塞对话
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
    contextK: prov.contextK,
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
    if (assistUnits.length) {
      // 模糊原子单元合并为**一次会话**：执行计划注入后由模型在单个工具循环
      // 内按序推进（自动续跑防停摆）——逐单元独立会话会让全量上下文往返
      // 翻 N 倍，是通信慢的主因
      const note = [
        deco ? knowledgeNote(deco) : "",
        directNote,
        planNote(assistUnits),
      ]
        .filter(Boolean)
        .join("\n\n");
      const messages = note ? [...wire, { role: "user" as const, content: note }] : wire;
      for (const u of assistUnits) markUnit(u.index, "running");
      const reply = await runAgent({ ...agentCommon, messages });
      finalText = reply.content.trim();
      const done = !stopRequested.value && finalText && !finalText.includes("已在此暂停");
      for (const u of assistUnits) markUnit(u.index, done ? "ok" : "fail");
      // 空回复兜底：绝不让一轮运行无声无息地结束
      convs.append(convId, {
        role: "assistant",
        content:
          finalText ||
          "（模型这一轮返回了空回复。回复「继续」让它接着执行；若反复出现，请检查供应商返回内容。）",
      });
    } else if (directResults.length) {
      // 纯直执行任务：全部原子命令已由大脑完成，零 LLM 直接汇总
      finalText =
        "任务完成（大脑原子执行）：\n" + directResults.map((r) => r.replace(/：.*$/, "")).join("\n");
      convs.append(convId, { role: "assistant", content: finalText });
    } else {
      // 直通路线：无原子单元的对话/指令任务，大脑知识命中注入后直通
      const messages = brainNote ? [...wire, { role: "user" as const, content: brainNote }] : wire;
      const reply = await runAgent({ ...agentCommon, messages });
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
  // @ 实时补全打开时优先接管：↑/↓ 移高亮、Enter 选中（不发送）、Esc 收起
  if (pickerOpen.value && pickerMode.value === "inline") {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      movePickerSel(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      movePickerSel(-1);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closePicker();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      pickPickerSel();
      return;
    }
  }
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
          <div
            class="achat-bubble"
            :class="{ 'achat-bubble-toolinfo': isToolCallInfo(b.m) }"
            :title="isToolCallInfo(b.m) && !toolInfoIsOpen(b.m) ? b.m.content : undefined"
          >
            <template v-if="isToolCallInfo(b.m)">
              <span
                class="achat-content achat-toolinfo-line"
                :class="{ open: toolInfoIsOpen(b.m) }"
                @click="toggleToolInfo(b.m)"
                @wheel="wheelToolInfo"
              >{{ b.m.content }}</span>
              <button
                class="achat-toolinfo-arrow"
                :title="toolInfoIsOpen(b.m) ? '收起' : '展开'"
                @click.stop="toggleToolInfo(b.m)"
              >{{ toolInfoIsOpen(b.m) ? "▾" : "▸" }}</button>
            </template>
            <span v-else class="achat-content">{{ b.m.content }}</span>
            <button
              class="achat-copy"
              :title="copiedId === b.m.id ? '已复制' : '复制'"
              @click.stop="copyMsg(b.m)"
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

    <!-- 点外部关闭（透明层；浮层锚定输入框上方，无遮罩变暗） -->
    <div v-if="pickerOpen" class="achat-picker-backdrop" @click="pickerOpen = false"></div>

    <div class="achat-input-wrap">
      <!-- 插入项目文件浮层：贴输入框上方的 popover（点 @ 自由搜索 / 输入 @ 实时补全） -->
      <div v-if="pickerOpen" class="achat-picker">
        <input
          v-show="pickerMode === 'button'"
          ref="pickerQEl"
          v-model="pickerQuery"
          class="achat-picker-q"
          placeholder="搜索路径…"
          @keydown.esc.stop.prevent="closePicker"
          @keydown.down.prevent="movePickerSel(1)"
          @keydown.up.prevent="movePickerSel(-1)"
          @keydown.enter.prevent="pickPickerSel"
        />
        <p v-if="pickerMode === 'inline'" class="achat-picker-meta">
          @ 引用工作区文件 · ↑↓ 选择 · Enter 插入 · Esc 关闭
        </p>
        <div class="achat-picker-list">
          <button
            v-for="(a, i) in filteredPicker()"
            :key="a.path"
            class="achat-picker-item"
            :class="{ sel: i === pickerSel }"
            :title="a.path"
            @click="insertAsset(a.path)"
            @mousemove="pickerSel = i"
          >
            <b>{{ a.kind }}</b> {{ a.path }}
          </button>
          <p v-if="pickerLoading" class="achat-picker-empty">读取中…</p>
          <p v-else-if="!filteredPicker().length" class="achat-picker-empty">无匹配</p>
        </div>
      </div>

      <div class="achat-input" :class="{ joined: pendingConfirm && !busy }">
        <textarea
          ref="textEl"
          v-model="input"
          class="achat-text"
          rows="1"
          placeholder="Enter 发送，Shift+Enter 换行；@ 引用项目文件"
          @keydown="onInputKey"
          @input="updateAtState"
          @keyup="updateAtState"
          @click="updateAtState"
        />
        <div class="achat-toolbar">
          <!-- @ 引用是工作区功能：通用会话（未绑定项目）没有可列/可读的项目文件，
               按钮不渲染，也就不会触发「没有工作区项目」的选择浮层报错 -->
          <button v-if="convs.activeRoot" class="achat-at" title="插入项目文件" :disabled="busy" @click="openPicker">@</button>
          <span class="achat-hint">Enter 发送 · Shift+Enter 换行</span>
          <button v-if="busy" class="achat-send stop" :title="stopRequested ? '正在等待当前步骤结束' : '终止执行'" @click="stopGeneration">
            {{ stopRequested ? "停止中…" : "停止" }}
          </button>
          <button v-else class="achat-send" :disabled="!canSend" @click="send()">发送</button>
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
/* 工具调用信息气泡：收敛 = 单行裁剪（无滚动条，滚轮左右平移），右侧箭头；
 * 展开 = 向下铺开全文（限高内部滚动） */
.achat-bubble-toolinfo {
  display: flex;
  align-items: flex-start;
  gap: 2px;
  padding-right: 26px;
  cursor: pointer;
  .achat-toolinfo-line {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    user-select: none;
    &.open {
      max-height: 240px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
      user-select: text;
      scrollbar-width: thin;
      cursor: text;
    }
  }
  .achat-toolinfo-arrow {
    flex: none;
    width: 16px;
    height: 18px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    color: var(--text-dim);
    font-size: 10px;
    line-height: 1;
    cursor: pointer;
    &:hover { color: var(--text); }
  }
}
.achat-typing { display: inline-flex; gap: 4px; i { width: 6px; height: 6px; border-radius: 50%; background: var(--text-dim); animation: atyp 1s infinite; &:nth-child(2) { animation-delay: 0.15s; } &:nth-child(3) { animation-delay: 0.3s; } } }
@keyframes atyp { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }
.achat-input-wrap { position: relative; flex: none; margin: 8px 10px 10px; }
.achat-input {
  display: flex;
  flex-direction: column;
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
/* 插入项目文件浮层：锚定输入框上方的 popover（无标题栏；点外部/Esc 关闭） */
.achat-picker-backdrop { position: fixed; inset: 0; z-index: 30; background: transparent; }
.achat-picker {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  right: 0;
  z-index: 31;
  display: flex;
  flex-direction: column;
  max-height: 320px;
  padding: 8px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.4);
}
.achat-picker-q { flex: none; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-input); color: var(--text); padding: 7px 10px; margin-bottom: 6px;
  &::placeholder { color: var(--text-dim); }
  &:focus { outline: none; border-color: var(--btn-hover); }
}
.achat-picker-meta { flex: none; margin: 0 0 6px; padding: 0 2px; font-size: 11px; color: var(--text-dim); }
.achat-picker-list { overflow-y: auto; min-height: 96px; display: flex; flex-direction: column; gap: 2px; }
.achat-picker-item {
  /* 限高 flex 容器内禁止行收缩：item 自带 overflow:hidden 会把 flex 最小尺寸
   * 归零，文件一多整列被等比压扁、文字竖向裁切且滚动失效（与步骤面板同坑） */
  flex: none;
  border: none; background: transparent; color: var(--text); text-align: left; padding: 6px 10px; border-radius: 8px; cursor: pointer; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  b { color: var(--text-dim); font-weight: 400; font-size: 11px; margin-right: 8px; }
  &:hover, &.sel { background: var(--bg-hover); }
}
.achat-picker-empty { flex: none; color: var(--text-dim); margin: 8px; }
</style>
