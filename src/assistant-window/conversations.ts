// ---------------------------------------------------------------------------
// 助手会话工作区（按项目隔离）：索引与消息文档分离——
// - 索引 assistant/conversations/index.json：{ projects: { [root]: { activeConvId, convs[] } } }，
//   启动全载；结构变更即时保存；
// - 消息文档 assistant/conversations/conv-<id>.json：按需加载，append 即时落盘
//   （无防抖：退出/崩溃的丢失窗口缩到单条在途写入）。
// root 为空串 = "通用"工作区（未打开项目）。非 Tauri 环境自动退化为纯内存。
// 丢失防护：所有写路径先等 ensureLoaded()——组件挂载并发早于索引读取完成时，
// 旧内存空副本会整体覆盖磁盘索引（历史丢会话根因），未加载完成绝不回写。
// ---------------------------------------------------------------------------

import { reactive } from "vue";
import { api } from "../lib/api";
import { isTauri } from "../lib/tauri-env";

export type ChatRole = "user" | "assistant" | "tool" | "error";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** role=tool：调用的方法名与回填 id（LLM wire 用 tool_call_id） */
  toolName?: string;
  toolCallId?: string;
  /** role=tool：true = 工具结果消息（false/缺省 = 调用消息） */
  result?: boolean;
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

/** 索引加载 promise（并发挂载共享同一次读取；完成后才允许任何回写） */
let loadPromise: Promise<void> | null = null;

function ensureLoaded(): Promise<void> {
  if (state.loaded) return Promise.resolve();
  if (!loadPromise) {
    loadPromise = (async () => {
      if (isTauri()) {
        try {
          const raw = await api.assistantConvIndexGet();
          const doc = raw ? (JSON.parse(raw) as ConvIndex) : null;
          if (doc?.projects) state.index = doc;
        } catch {
          /* 索引损坏按空索引处理（各会话文档仍在，可经会话树重建） */
        }
      }
      state.loaded = true;
    })();
  }
  return loadPromise;
}

function saveIndex(): void {
  // 未加载完成绝不回写：磁盘索引会被内存空副本整体覆盖（丢会话根因）
  if (!isTauri() || !state.loaded) return;
  void api.assistantConvIndexSet(JSON.stringify(state.index)).catch(() => {
    /* 存储不可用：仅本次会话有效 */
  });
}

/** 消息文档即时落盘（每条消息一次小文件原子写） */
function saveDoc(convId: string): void {
  if (!isTauri()) return;
  const msgs = state.cache.get(convId);
  if (!msgs) return;
  void api.assistantConvDocSet(convId, JSON.stringify({ messages: msgs })).catch(() => {
    /* 存储不可用：仅本次会话有效 */
  });
}

/** 并发挂载的建会话互斥：AssistantApp 与 AssistantChat 同时初始化时只建一次 */
let creating: Promise<string> | null = null;

function workspaceOf(root: string): Workspace {
  if (!state.index.projects[root]) {
    state.index.projects[root] = { activeConvId: null, convs: [] };
  }
  return state.index.projects[root];
}

/** 读会话消息文档（缓存命中直接返回） */
async function loadDoc(convId: string): Promise<void> {
  if (state.cache.has(convId)) return;
  if (isTauri()) {
    try {
      const raw = await api.assistantConvDocGet(convId);
      const doc = raw ? (JSON.parse(raw) as { messages?: ChatMessage[] }) : null;
      state.cache.set(convId, doc?.messages ?? []);
    } catch {
      state.cache.set(convId, []);
    }
  } else {
    state.cache.set(convId, []);
  }
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
  /** 清理已删除项目的工作区（exists=false = 该项目目录已消失）：其全部会话
   *  与文档一并清除；激活工作区命中时回落通用。返回被清理的根清单。 */
  pruneMissing: (exists: (root: string) => Promise<boolean>) => Promise<string[]>;
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
      await ensureLoaded();
    },
    async switchProject(root) {
      await ensureLoaded();
      state.activeRoot = root;
      const ws = workspaceOf(root);
      if (!ws.activeConvId && ws.convs.length === 0) {
        const conv: ConvMeta = { id: uid(), title: "新会话", updatedAt: Date.now() };
        ws.convs.push(conv);
        ws.activeConvId = conv.id;
        saveIndex();
      }
      if (ws.activeConvId) {
        await loadDoc(ws.activeConvId);
      }
    },
    convs() {
      return workspaceOf(state.activeRoot).convs;
    },
    activeConvId() {
      return workspaceOf(state.activeRoot).activeConvId;
    },
    async ensureActiveMessages() {
      await ensureLoaded();
      const ws = workspaceOf(state.activeRoot);
      if (!ws.activeConvId) {
        // 两路并发同时发现无会话：共享同一次建会话，避免双会话
        if (!creating) {
          creating = this.newConversation(state.activeRoot).finally(() => {
            creating = null;
          });
        }
        await creating;
      }
      const id = workspaceOf(state.activeRoot).activeConvId as string;
      await loadDoc(id);
      return state.cache.get(id) as ChatMessage[];
    },
    async selectConv(root, convId) {
      await ensureLoaded();
      const ws = workspaceOf(root);
      if (!ws.convs.some((c) => c.id === convId)) return;
      ws.activeConvId = convId;
      saveIndex();
      await loadDoc(convId);
    },
    convsOf(root) {
      return state.index.projects[root]?.convs ?? [];
    },
    activeConvIdOf(root) {
      return state.index.projects[root]?.activeConvId ?? null;
    },
    async newConversation(root, title) {
      await ensureLoaded();
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
      saveDoc(convId);
      return full;
    },
    remove(root, convId) {
      // 未加载完成拒绝删除：内存副本不是磁盘真相，删了会在下次 load 复活
      if (!state.loaded) return;
      const ws = workspaceOf(root);
      const i = ws.convs.findIndex((c) => c.id === convId);
      if (i < 0) return;
      ws.convs.splice(i, 1);
      state.cache.delete(convId);
      if (ws.activeConvId === convId) ws.activeConvId = ws.convs[ws.convs.length - 1]?.id ?? null;
      saveIndex();
      if (isTauri()) void api.assistantConvDocDelete(convId).catch(() => {});
    },
    async pruneMissing(exists) {
      await ensureLoaded();
      const gone: string[] = [];
      for (const root of Object.keys(state.index.projects)) {
        if (!root) continue; // 通用工作区不参与探测
        if (await exists(root)) continue;
        gone.push(root);
      }
      if (!gone.length) return [];
      for (const root of gone) {
        for (const c of state.index.projects[root].convs) {
          state.cache.delete(c.id);
          if (isTauri()) void api.assistantConvDocDelete(c.id).catch(() => {});
        }
        delete state.index.projects[root];
      }
      if (state.activeRoot && gone.includes(state.activeRoot)) {
        await this.switchProject("");
      } else {
        saveIndex();
      }
      return gone;
    },
    flush() {
      // 消息文档已即时落盘，这里只剩索引兜底
      saveIndex();
    },
  };
}
