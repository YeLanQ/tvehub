// ---------------------------------------------------------------------------
// 助手配置 store（单例）：智能体卡片 + LLM 供应商。持久化经 ui-state KV
// （tve:ai:cards / tve:ai:providers，本机配置目录），非 Tauri 环境（浏览器/测试）
// 自动退化为纯内存。watch 防抖写盘；加载完成前不回写，避免默认值覆盖存档。
// ---------------------------------------------------------------------------

import { reactive } from "vue";
import { uiStateGet, uiStateSet } from "../lib/ui-state";
import { isTauri } from "../lib/tauri-env";

const KEY_CARDS = "tve:ai:cards";
const KEY_PROVIDERS = "tve:ai:providers";

export interface AgentCard {
  id: string;
  name: string;
  /** 人设描述（角色/口吻/专长；systemPrompt 为空时拼进默认系统提示词） */
  persona: string;
  /** 完整自定义系统提示词（非空则替代默认提示词，仍附加工具与技能索引） */
  systemPrompt: string;
  /** 空会话首条助手消息（引导语） */
  firstMessage: string;
  tags: string[];
  /** 覆盖全局模型的模型名（空串 = 用当前供应商的 model） */
  model: string;
  /** 覆盖采样温度（null = 供应商默认） */
  temperature: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AiProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** /models 拉取结果（可失败；手填模型合并去重） */
  models: string[];
  /** 上下文窗口（千 token）：0 = 默认 128；1024 = 1M——按模型实际窗口填写，
   *  助手据此放大工具结果上限与历史保留预算，装不下才裁最老历史 */
  contextK: number;
  /** 思考模式：default = 不传参跟随模型默认；on = 显式开启；off = 显式关闭
   *  （关闭更快更省 token）。显式开关按主流方言并发（GLM/Qwen/o系），
   *  个别严格校验的供应商可能 400，届时选回 default */
  thinking?: "default" | "on" | "off";
  /** 思考强度（thinking = on 时随 reasoning_effort 下发）；各家档位不一：
   *  低/中/高 通用，xhigh 仅部分模型（GPT-5.1-Codex-Max 等），低/高两档模型
   *  传 medium 可能被夹或报错——换一档即可 */
  thinkingEffort?: "low" | "medium" | "high" | "xhigh";
}

interface CardsDoc {
  activeCardId: string;
  cards: AgentCard[];
}
interface ProvidersDoc {
  activeProviderId: string;
  providers: AiProvider[];
}

function uid(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.floor(Math.random() * 1e8).toString(36);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

function defaultCard(): AgentCard {
  const now = Date.now();
  return {
    id: uid("card"),
    name: "TvE 助手",
    persona:
      "你是三维可视化编辑器的随行助手，熟悉场景搭建、资产与脚本，回答简明、给可执行步骤。",
    systemPrompt: "",
    firstMessage: "我是 TvE 助手。可以问操作方法、让我代跑命令（加节点/起预览等），或让我写脚本。",
    tags: [],
    model: "",
    temperature: null,
    createdAt: now,
    updatedAt: now,
  };
}

export interface AssistantStore {
  cards: AgentCard[];
  activeCardId: string;
  providers: AiProvider[];
  activeProviderId: string;
  /** 异步装载存档（首次 get 后调用一次；就绪前读默认值） */
  load: () => Promise<void>;
  readonly activeCard: AgentCard | null;
  readonly activeProvider: AiProvider | null;
  setActiveCard: (id: string) => void;
  createCard: (partial?: Partial<AgentCard>) => AgentCard;
  updateCard: (id: string, patch: Partial<AgentCard>) => void;
  deleteCard: (id: string) => void;
  duplicateCard: (id: string) => AgentCard | null;
  setActiveProvider: (id: string) => void;
  createProvider: (partial?: Partial<AiProvider>) => AiProvider;
  updateProvider: (id: string, patch: Partial<AiProvider>) => void;
  deleteProvider: (id: string) => void;
}

let singleton: AssistantStore | null = null;

export function getAssistantStore(): AssistantStore {
  if (singleton) return singleton;
  const defaultCard0 = defaultCard();
  const state = reactive({
    cards: [defaultCard0] as AgentCard[],
    activeCardId: defaultCard0.id,
    providers: [] as AiProvider[],
    activeProviderId: "",
    loaded: false,
  });

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleSave(): void {
    if (!state.loaded || !isTauri()) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const cards: CardsDoc = {
        activeCardId: state.activeCardId,
        cards: state.cards.map((c) => ({ ...c })),
      };
      const providers: ProvidersDoc = {
        activeProviderId: state.activeProviderId,
        providers: state.providers.map((p) => ({ ...p, models: [...p.models] })),
      };
      void uiStateSet(KEY_CARDS, cards);
      void uiStateSet(KEY_PROVIDERS, providers);
    }, 300);
  }

  const store: AssistantStore = {
    get cards() {
      return state.cards;
    },
    get activeCardId() {
      return state.activeCardId;
    },
    get providers() {
      return state.providers;
    },
    get activeProviderId() {
      return state.activeProviderId;
    },
    get activeCard(): AgentCard | null {
      return state.cards.find((c) => c.id === state.activeCardId) ?? null;
    },
    get activeProvider(): AiProvider | null {
      return state.providers.find((p) => p.id === state.activeProviderId) ?? null;
    },
    async load() {
      if (state.loaded) return;
      const [cards, providers] = (await Promise.all([
        uiStateGet<CardsDoc>(KEY_CARDS),
        uiStateGet<ProvidersDoc>(KEY_PROVIDERS),
      ])) as [CardsDoc | null, ProvidersDoc | null];
      if (cards?.cards?.length) {
        state.cards = cards.cards;
        state.activeCardId =
          cards.activeCardId && cards.cards.some((c) => c.id === cards.activeCardId)
            ? cards.activeCardId
            : cards.cards[0].id;
      }
      if (providers?.providers) {
        state.providers = providers.providers;
        state.activeProviderId = providers.activeProviderId;
      }
      state.loaded = true;
    },
    setActiveCard(id) {
      if (state.cards.some((c) => c.id === id)) state.activeCardId = id;
    },
    createCard(partial) {
      const card: AgentCard = {
        ...defaultCard(),
        name: "新卡片",
        firstMessage: "",
        persona: "",
        ...partial,
        id: uid("card"),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      state.cards.push(card);
      state.activeCardId = card.id;
      scheduleSave();
      return card;
    },
    updateCard(id, patch) {
      const card = state.cards.find((c) => c.id === id);
      if (!card) return;
      Object.assign(card, patch, { updatedAt: Date.now() });
      scheduleSave();
    },
    deleteCard(id) {
      if (state.cards.length <= 1) return;
      const i = state.cards.findIndex((c) => c.id === id);
      if (i < 0) return;
      state.cards.splice(i, 1);
      if (state.activeCardId === id) state.activeCardId = state.cards[0].id;
      scheduleSave();
    },
    duplicateCard(id) {
      const src = state.cards.find((c) => c.id === id);
      if (!src) return null;
      return store.createCard({
        ...src,
        name: `${src.name} 副本`,
      });
    },
    setActiveProvider(id) {
      if (state.providers.some((p) => p.id === id)) state.activeProviderId = id;
      scheduleSave();
    },
    createProvider(partial) {
      const provider: AiProvider = {
        id: uid("prov"),
        name: "新供应商",
        baseUrl: "",
        apiKey: "",
        model: "",
        models: [],
        contextK: 128,
        thinking: "default",
        thinkingEffort: "medium",
        ...partial,
      };
      state.providers.push(provider);
      if (!state.activeProviderId) state.activeProviderId = provider.id;
      scheduleSave();
      return provider;
    },
    updateProvider(id, patch) {
      const provider = state.providers.find((p) => p.id === id);
      if (!provider) return;
      Object.assign(provider, patch);
      scheduleSave();
    },
    deleteProvider(id) {
      const i = state.providers.findIndex((p) => p.id === id);
      if (i < 0) return;
      state.providers.splice(i, 1);
      if (state.activeProviderId === id) {
        state.activeProviderId = state.providers[0]?.id ?? "";
      }
      scheduleSave();
    },
  };
  singleton = store;
  return store;
}

/** 测试与重挂载用：清空单例 */
export function resetAssistantStore(): void {
  singleton = null;
}
