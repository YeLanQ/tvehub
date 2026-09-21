// ---------------------------------------------------------------------------
// 助手会话工作区（按项目隔离）：索引与消息文档分离——
// - 索引 tve:ai:conv-index：{ projects: { [root]: { activeConvId, convs[] } } }，
//   启动全载；结构变更即时保存；
// - 消息文档 tve:ai:conv:<id>：按需加载，改动 400ms 防抖保存。
// root 为空串 = "通用"工作区（未打开项目）。非 Tauri 环境自动退化为纯内存。
// ---------------------------------------------------------------------------

import { reactive } from "vue";
import { uiStateGet, uiStateSet } from "../lib/ui-state";
import { isTauri } from "../lib/tauri-env";

const KEY_INDEX = "tve:ai:conv-index";
const KEY_CONV = "tve:ai:conv:";

export type ChatRole = "user" | "assistant" | "tool" | "error";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** role=tool：调用的方法名与回填 id（LLM wire 用 tool_call_id） */
  toolName?: string;
  toolCallId?: string;
  createdAt: number;
}

export interface ConvMeta {
  id: string;
  title: string;
  updatedAt: number;
}

interface Workspace {
  activeConvId: string | null;
  convs: ConvMeta[];
}

interface ConvIndex {
  projects: Record<string, Workspace>;
}

function uid(): string {
  return `c_${Date.now().toString(36)}${Math.floor(Math.random() * 1e8).toString(36)}`;
}

const state = reactive({
  index: { projects: {} } as ConvIndex,
  activeRoot: "",
  cache: new Map<string, ChatMessage[]>(),
  loaded: false,
});

/** 消息文档保存防抖（convId -> timer） */
const docTimers = new Map<string, ReturnType<typeof setTimeout>>();

function workspaceOf(root: string): Workspace {
  if (!state.index.projects[root]) {
    state.index.projects[root] = { activeConvId: null, convs: [] };
  }
  return state.index.projects[root];
}

function saveIndex(): void {
  if (!isTauri()) return;
  void uiStateSet(KEY_INDEX, state.index);
}

function scheduleSaveDoc(convId: string): void {
  if (!isTauri()) return;
  const prev = docTimers.get(convId);
  if (prev) clearTimeout(prev);
  docTimers.set(
    convId,
    setTimeout(() => {
      docTimers.delete(convId);
      const msgs = state.cache.get(convId);
      if (msgs) void uiStateSet(KEY_CONV + convId, { messages: msgs });
    }, 400),
  );
}

export interface ConversationsStore {
  /** 当前工作区项目根（空串 = 通用） */
  readonly activeRoot: string;
  readonly index: ConvIndex;
  /** 装载索引（启动调用一次） */
  load: () => Promise<void>;
  /** 切换工作区（确保有会话与消息在缓存） */
  switchProject: (root: string) => Promise<void>;
  /** 当前工作区的会话清单 */
  convs: () => ConvMeta[];
  /** 当前激活会话 id（无则已建好新会话） */
  activeConvId: () => string | null;
  /** 确保存在会话并返回其消息数组（reactive 引用） */
  ensureActiveMessages: () => Promise<ChatMessage[]>;
  /** 切换到工作区内已有的会话（加载消息缓存） */
  selectConv: (root: string, convId: string) => Promise<void>;
  /** 某工作区的会话清单（不切换工作区也可读，供会话树渲染） */
  convsOf: (root: string) => ConvMeta[];
  /** 某工作区的激活会话 id（不改变任何状态） */
  activeConvIdOf: (root: string) => string | null;
  /** 新建会话并切换 */
  newConversation: (root: string, title?: string) => Promise<string>;
  /** 追加消息（自动 touch 元信息 + 防抖保存） */
  append: (convId: string, msg: Omit<ChatMessage, "id" | "createdAt">) => ChatMessage;
  /** 删除会话（清理缓存与文档） */
  remove: (root: string, convId: string) => void;
  /** 立即写盘全部待保存文档（窗口关闭前调用） */
  flush: () => void;
}

function touch(convId: string, root: string, title?: string): void {
  const ws = workspaceOf(root);
  const meta = ws.convs.find((c) => c.id === convId);
  if (meta) {
    meta.updatedAt = Date.now();
    // 默认名（"新会话"/"新会话 HH:mm"）才允许被首条用户消息改名，之后保持稳定
    if (title && (meta.title === "新会话" || meta.title.startsWith("新会话 "))) {
      meta.title = title;
    }
  }
  saveIndex();
}

/** 新会话默认名的可分辨时间戳（MM-DD HH:mm） */
function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function getConversations(): ConversationsStore {
  return {
    get activeRoot() {
      return state.activeRoot;
    },
    get index() {
      return state.index;
    },
    async load() {
      if (state.loaded) return;
      const doc = await uiStateGet<ConvIndex>(KEY_INDEX);
      if (doc?.projects) state.index = doc;
      state.loaded = true;
    },
    async switchProject(root) {
      state.activeRoot = root;
      const ws = workspaceOf(root);
      if (!ws.activeConvId && ws.convs.length === 0) {
        const conv: ConvMeta = { id: uid(), title: "新会话", updatedAt: Date.now() };
        ws.convs.push(conv);
        ws.activeConvId = conv.id;
        saveIndex();
      }
      if (ws.activeConvId) {
        const id = ws.activeConvId;
        if (!state.cache.has(id)) {
          const doc = await uiStateGet<{ messages: ChatMessage[] }>(KEY_CONV + id);
          state.cache.set(id, doc?.messages ?? []);
        }
      }
    },
    convs() {
      return workspaceOf(state.activeRoot).convs;
    },
    activeConvId() {
      return workspaceOf(state.activeRoot).activeConvId;
    },
    async ensureActiveMessages() {
      const ws = workspaceOf(state.activeRoot);
      if (!ws.activeConvId) {
        await this.newConversation(state.activeRoot);
      }
      const id = workspaceOf(state.activeRoot).activeConvId as string;
      if (!state.cache.has(id)) {
        const doc = await uiStateGet<{ messages: ChatMessage[] }>(KEY_CONV + id);
        state.cache.set(id, doc?.messages ?? []);
      }
      return state.cache.get(id) as ChatMessage[];
    },
    async selectConv(root, convId) {
      const ws = workspaceOf(root);
      if (!ws.convs.some((c) => c.id === convId)) return;
      ws.activeConvId = convId;
      saveIndex();
      if (!state.cache.has(convId)) {
        const doc = await uiStateGet<{ messages: ChatMessage[] }>(KEY_CONV + convId);
        state.cache.set(convId, doc?.messages ?? []);
      }
    },
    convsOf(root) {
      return state.index.projects[root]?.convs ?? [];
    },
    activeConvIdOf(root) {
      return state.index.projects[root]?.activeConvId ?? null;
    },
    async newConversation(root, title) {
      const ws = workspaceOf(root);
      const conv: ConvMeta = {
        id: uid(),
        title: title ?? `新会话 ${stamp()}`,
        updatedAt: Date.now(),
      };
      ws.convs.push(conv);
      ws.activeConvId = conv.id;
      state.cache.set(conv.id, []);
      saveIndex();
      return conv.id;
    },
    append(convId, msg) {
      const full: ChatMessage = {
        ...msg,
        id: uid(),
        createdAt: Date.now(),
      };
      const msgs = state.cache.get(convId) ?? [];
      msgs.push(full);
      state.cache.set(convId, msgs);
      // 标题只在默认名阶段被首条用户消息命名一次，之后保持稳定
      touch(convId, state.activeRoot, msg.role === "user" ? msg.content.slice(0, 24) : undefined);
      scheduleSaveDoc(convId);
      return full;
    },
    remove(root, convId) {
      const ws = workspaceOf(root);
      const i = ws.convs.findIndex((c) => c.id === convId);
      if (i < 0) return;
      ws.convs.splice(i, 1);
      state.cache.delete(convId);
      if (ws.activeConvId === convId) ws.activeConvId = ws.convs[ws.convs.length - 1]?.id ?? null;
      saveIndex();
      if (isTauri()) void uiStateSet(KEY_CONV + convId, null);
    },
    flush() {
      if (!isTauri()) return;
      for (const [convId, timer] of docTimers) {
        clearTimeout(timer);
        const msgs = state.cache.get(convId);
        if (msgs) void uiStateSet(KEY_CONV + convId, { messages: msgs });
      }
      docTimers.clear();
      saveIndex();
    },
  };
}
