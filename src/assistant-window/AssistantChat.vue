<script setup lang="ts">
// ---------------------------------------------------------------------------
// 助手聊天主区：消息流（用户/助手/工具芯片/错误）+ 流式增量 + 输入框。
// 发送 = 组装 system(环境提示词+人设+工具+技能索引) + 历史 → 工具循环；
// @插入：资产列表选择 → asset.read 文本 → fenced 块追加进输入框。
// ---------------------------------------------------------------------------
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { toastErr } from "../ui-kit";
import { getAssistantStore } from "./store";
import { parseFileRefs, isBinaryRef } from "./refs";
import { getConversations, type ChatMessage } from "./conversations";
import {
  buildSystemPrompt,
  createTauriTransport,
  runAgent,
  toWire,
} from "./agent";
import { assistantTools, execAssistantTool } from "./tools";

const store = getAssistantStore();
const convs = getConversations();

const messages = ref<ChatMessage[]>([]);
const input = ref("");
const busy = ref(false);
const streamingText = ref("");
const scrollBox = ref<HTMLElement | null>(null);
const textEl = ref<HTMLTextAreaElement | null>(null);

/** 当前会话标题（首条用户消息自动命名，缺省"新会话"） */
const activeTitle = computed(() => {
  const id = convs.activeConvId();
  return convs.convs().find((c) => c.id === id)?.title ?? "新会话";
});

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

async function send(): Promise<void> {
  const text = input.value.trim();
  const prov = provider.value;
  if (!text || busy.value || !prov) return;
  if (!prov.baseUrl.trim() || !prov.model.trim()) {
    toastErr("请先在「设置 → 供应商」填写地址与模型");
    return;
  }
  input.value = "";
  const convId = convs.activeConvId();
  if (!convId) return;
  convs.append(convId, { role: "user", content: text });
  // @引用在发送时解析：文本文件全文注入 wire（不进可见消息）
  const refs = parseFileRefs(text);
  const attachments = refs.length ? await resolveRefAttachments(refs) : "";
  const history = toWire(messages.value);
  const card0 = card.value;
  const wire = [
    { role: "system" as const, content: buildSystemPrompt(card0, convs.activeRoot) },
    // 历史末尾是刚追加的用户消息 → 替换为"原文 + 引用附件"版本
    ...history.slice(0, -1),
    { role: "user" as const, content: text + attachments },
  ];
  busy.value = true;
  streamingText.value = "";
  try {
    const reply = await runAgent({
      messages: wire,
      tools: assistantTools(),
      chat: createTauriTransport(),
      execTool: (name, argsJson) =>
        execAssistantTool(name, argsJson, convs.activeRoot || undefined),
      baseUrl: prov.baseUrl,
      apiKey: prov.apiKey,
      model: card0?.model?.trim() ? card0.model.trim() : prov.model,
      temperature: card0?.temperature ?? undefined,
      onDelta: (t) => {
        streamingText.value = t;
      },
      onEvent: (e) => {
        if (e.type === "tool_start") {
          convs.append(convId, {
            role: "tool",
            content: `${e.name}(${e.args ?? ""})`,
            toolName: e.name,
          });
        }
      },
    });
    convs.append(convId, { role: "assistant", content: reply.content });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    convs.append(convId, { role: "error", content: msg });
    toastErr(msg);
  } finally {
    busy.value = false;
    streamingText.value = "";
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
      <template v-for="m in messages" :key="m.id">
        <div v-if="m.role === 'tool'" class="achat-chip" :title="m.content">
          ⚙ {{ m.content.length > 90 ? m.content.slice(0, 90) + "…" : m.content }}
        </div>
        <div
          v-else-if="m.role === 'error'"
          class="achat-bubble achat-bubble-error"
        >{{ m.content }}</div>
        <div v-else class="achat-row" :class="m.role">
          <div class="achat-bubble">{{ m.content }}</div>
        </div>
      </template>
      <div v-if="busy" class="achat-row assistant">
        <div v-if="streamingText" class="achat-bubble">{{ streamingText }}▌</div>
        <div v-else class="achat-bubble achat-typing"><i /><i /><i /></div>
      </div>
    </div>

    <div class="achat-input">
      <textarea
        ref="textEl"
        v-model="input"
        class="achat-text"
        rows="1"
        placeholder="Enter 发送，Shift+Enter 换行"
        @keydown="onInputKey"
      />
      <div class="achat-toolbar">
        <button class="achat-at" title="插入项目文件" :disabled="busy" @click="openPicker">@</button>
        <span class="achat-hint">Enter 发送 · Shift+Enter 换行</span>
        <button class="achat-send" :disabled="!canSend" @click="send">发送</button>
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
  max-width: 88%; padding: 7px 10px; border-radius: 10px;
  background: var(--bg-hover); white-space: pre-wrap; word-break: break-word;
  .user & { background: var(--bg-active); }
}
.achat-bubble-error { border: 1px solid var(--err); color: var(--err); border-radius: 10px; padding: 7px 10px; margin: 6px 0; white-space: pre-wrap; }
.achat-chip { font: 11px/1.6 ui-monospace, Consolas, monospace; color: var(--ok); background: var(--bg-input); border-radius: 6px; padding: 2px 8px; margin: 3px 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
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
  &:disabled { opacity: 0.45; cursor: default; } }
.achat-picker { position: fixed; inset: 0; background: rgb(0 0 0 / 0.45); display: flex; align-items: center; justify-content: center; }
.achat-picker-box { width: 82%; max-height: 70%; display: flex; flex-direction: column; background: var(--bg-panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px; }
.achat-picker-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; color: var(--text); button { border: none; background: transparent; color: var(--text-dim); font-size: 16px; cursor: pointer; } }
.achat-picker-q { border: 1px solid var(--border); border-radius: 6px; background: var(--bg-input); color: var(--text); padding: 6px 8px; margin-bottom: 8px; }
.achat-picker-list { overflow-y: auto; min-height: 120px; display: flex; flex-direction: column; gap: 2px; }
.achat-picker-item { border: none; background: transparent; color: var(--text); text-align: left; padding: 5px 8px; border-radius: 6px; cursor: pointer; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; b { color: var(--text-dim); font-weight: 400; margin-right: 6px; } &:hover { background: var(--bg-hover); } }
.achat-picker-empty { color: var(--text-dim); margin: 8px; }
</style>
