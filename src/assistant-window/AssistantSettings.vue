<script setup lang="ts">
// ---------------------------------------------------------------------------
// 助手设置视图（右栏就地切换）：分区 1 = 智能体卡片（增删改/复制/导入导出），
// 分区 2 = 供应商（多端点 + 拉取模型 + 激活选择）。字段改动即时持久化。
// ---------------------------------------------------------------------------
import { computed, onMounted, ref } from "vue";
import { api } from "../lib/api";
import { ToastHost, toastErr, toastOk } from "../ui-kit";
import ComboBox from "../ui-kit/components/ComboBox.vue";
import { getAssistantStore, type AgentCard, type AiProvider } from "./store";

const emit = defineEmits<{ close: [] }>();

const store = getAssistantStore();
const section = ref<"cards" | "providers">("cards");
const editingCardId = ref<string | null>(null);
const showKey = ref(false);
const fetching = ref(false);

onMounted(() => {
  if (!store.providers.length) {
    store.createProvider({ name: "OpenAI 兼容", baseUrl: "https://api.openai.com/v1" });
  }
  editingCardId.value = store.activeCardId;
});

const editingCard = computed<AgentCard | null>(
  () => store.cards.find((c) => c.id === editingCardId.value) ?? null,
);
const activeProvider = computed<AiProvider | null>(
  () => store.providers.find((p) => p.id === store.activeProviderId) ?? null,
);

function touchCard(): void {
  if (editingCard.value) store.updateCard(editingCard.value.id, {});
}
function setCardField(
  field: "name" | "persona" | "systemPrompt" | "firstMessage",
  ev: Event,
): void {
  const el = ev.target as HTMLInputElement;
  if (editingCard.value) store.updateCard(editingCard.value.id, { [field]: el.value });
}
function setCardTags(ev: Event): void {
  if (!editingCard.value) return;
  const raw = (ev.target as HTMLInputElement).value;
  store.updateCard(editingCard.value.id, {
    tags: raw.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
  });
}
function setCardModel(value: string): void {
  if (editingCard.value) store.updateCard(editingCard.value.id, { model: value });
}
function setCardTemperature(ev: Event): void {
  const el = ev.target as HTMLInputElement;
  if (editingCard.value) {
    store.updateCard(editingCard.value.id, {
      temperature: el.value === "" ? null : Number(el.value),
    });
  }
}
function setProviderField(
  field: "name" | "baseUrl" | "apiKey" | "model",
  ev: Event,
): void {
  const el = ev.target as HTMLInputElement;
  if (activeProvider.value) store.updateProvider(activeProvider.value.id, { [field]: el.value });
}
function setProviderModel(value: string): void {
  if (activeProvider.value) store.updateProvider(activeProvider.value.id, { model: value });
}
function setProviderContextK(ev: Event): void {
  const el = ev.target as HTMLInputElement;
  const n = Number(el.value);
  const k = Number.isFinite(n) && n > 0 ? Math.min(2048, Math.round(n)) : 0;
  if (activeProvider.value) store.updateProvider(activeProvider.value.id, { contextK: k });
}

function exportCards(): void {
  const doc = JSON.stringify(store.cards, null, 2);
  const blob = new Blob([doc], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "tve-assistant-cards.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

function importCards(): void {
  const inputEl = document.createElement("input");
  inputEl.type = "file";
  inputEl.accept = ".json";
  inputEl.onchange = () => {
    const file = inputEl.files?.[0];
    if (!file) return;
    void file.text().then((text) => {
      try {
        const parsed = JSON.parse(text) as Partial<AgentCard> | Partial<AgentCard>[];
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const p of arr) {
          store.createCard({
            name: p.name ?? "导入卡片",
            persona: p.persona ?? "",
            systemPrompt: p.systemPrompt ?? "",
            firstMessage: p.firstMessage ?? "",
            tags: Array.isArray(p.tags) ? p.tags : [],
          });
        }
        toastOk(`已导入 ${arr.length} 张卡片`);
      } catch {
        toastErr("导入失败：不是合法的卡片 JSON");
      }
    });
  };
  inputEl.click();
}

async function fetchModels(): Promise<void> {
  const p = activeProvider.value;
  if (!p?.baseUrl?.trim()) {
    toastErr("先填供应商地址");
    return;
  }
  fetching.value = true;
  try {
    const models = await api.aiListModels(p.baseUrl, p.apiKey);
    const merged = [...new Set([...models, ...(p.models ?? [])])];
    store.updateProvider(p.id, { models: merged });
    if (!p.model && models.length) store.updateProvider(p.id, { model: models[0] });
    if (models.length) toastOk(`拉到 ${models.length} 个模型`);
    else toastErr("端点未返回模型清单，可手填模型名");
  } catch (e) {
    toastErr(`拉取失败：${e instanceof Error ? e.message : String(e)}（可手填模型）`);
  } finally {
    fetching.value = false;
  }
}
</script>

<template>
  <div class="aset">
    <div class="aset-tabs">
      <button :class="{ on: section === 'cards' }" @click="section = 'cards'">智能体卡片</button>
      <button :class="{ on: section === 'providers' }" @click="section = 'providers'">供应商</button>
      <button class="aset-back" @click="emit('close')">返回对话</button>
    </div>

    <!-- 卡片 -->
    <div v-if="section === 'cards'" class="aset-body">
      <div class="aset-list">
        <button
          v-for="c in store.cards"
          :key="c.id"
          class="aset-item"
          :class="{ active: c.id === store.activeCardId }"
          @click="editingCardId = c.id"
        >
          {{ c.name }}<span v-if="c.id === store.activeCardId" class="aset-flag">当前</span>
        </button>
      </div>
      <div class="aset-actions">
        <button @click="store.createCard(); editingCardId = store.activeCardId">新建</button>
        <button @click="editingCard && store.duplicateCard(editingCard.id)">复制</button>
        <button :disabled="store.cards.length <= 1" @click="editingCard && store.deleteCard(editingCard.id)">删除</button>
        <button @click="exportCards">导出</button>
        <button @click="importCards">导入</button>
      </div>
      <template v-if="editingCard">
        <label>名称<input :value="editingCard.name" @change="setCardField('name', $event)" /></label>
        <label>人设（空则用默认）<textarea :value="editingCard.persona" rows="3" @change="setCardField('persona', $event)" /></label>
        <label>自定义系统提示词（高级；空 = 默认提示词 + 人设）<textarea :value="editingCard.systemPrompt" rows="4" @change="setCardField('systemPrompt', $event)" /></label>
        <label>开场白<textarea :value="editingCard.firstMessage" rows="2" @change="setCardField('firstMessage', $event)" /></label>
        <label>标签（逗号分隔）<input :value="editingCard.tags.join(', ')" @change="setCardTags" /></label>
        <div class="aset-grid">
          <label>覆盖模型（空 = 供应商模型）<ComboBox :model-value="editingCard.model" :options="activeProvider?.models ?? []" placeholder="留空用供应商模型" @update:model-value="setCardModel" /></label>
          <label>温度（空 = 默认）<input :value="editingCard.temperature ?? ''" type="number" step="0.1" min="0" max="2" @change="setCardTemperature" /></label>
        </div>
        <button v-if="editingCard.id !== store.activeCardId" class="aset-activate" @click="store.setActiveCard(editingCard.id); touchCard()">设为当前卡片</button>
      </template>
    </div>

    <!-- 供应商 -->
    <div v-else class="aset-body">
      <div class="aset-list">
        <button
          v-for="p in store.providers"
          :key="p.id"
          class="aset-item"
          :class="{ active: p.id === store.activeProviderId }"
          @click="store.setActiveProvider(p.id)"
        >
          {{ p.name }}<span v-if="p.id === store.activeProviderId" class="aset-flag">当前</span>
        </button>
      </div>
      <div class="aset-actions">
        <button @click="store.createProvider()">新增</button>
        <button :disabled="!activeProvider" @click="activeProvider && store.deleteProvider(activeProvider.id)">删除</button>
      </div>
      <template v-if="activeProvider">
        <label>名称<input :value="activeProvider.name" @change="setProviderField('name', $event)" /></label>
        <label>API 地址（OpenAI 兼容，含 /v1）<input :value="activeProvider.baseUrl" placeholder="https://api.openai.com/v1" @change="setProviderField('baseUrl', $event)" /></label>
        <label>API Key（仅保存在本机）<div class="aset-keyrow"><input :type="showKey ? 'text' : 'password'" :value="activeProvider.apiKey" @change="setProviderField('apiKey', $event)" /><button @click="showKey = !showKey">{{ showKey ? '隐藏' : '显示' }}</button></div></label>
        <label>模型（可手填，或先「拉取模型列表」再选）<ComboBox :model-value="activeProvider.model" :options="activeProvider.models" placeholder="gpt-4o-mini / deepseek-chat / …" @update:model-value="setProviderModel" /></label>
        <label>上下文窗口 K token（按模型实际窗口填，0 = 默认 128；1024 = 1M）<input :value="activeProvider.contextK ?? 128" type="number" min="0" max="2048" step="1" placeholder="128" @change="setProviderContextK" /></label>
        <div class="aset-actions">
          <button :disabled="fetching" @click="fetchModels">{{ fetching ? "拉取中…" : "拉取模型列表" }}</button>
        </div>
      </template>
    </div>

    <ToastHost />
  </div>
</template>

<style scoped lang="scss">
.aset { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow-y: auto; user-select: text; }
.aset-tabs { display: flex; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--border); flex: none; align-items: center;
  button { border: 1px solid var(--border); background: var(--btn); color: var(--text-dim); border-radius: 6px; padding: 4px 10px; cursor: pointer;
    &.on { background: var(--bg-active); color: var(--text); border-color: var(--accent); } }
  .aset-back { margin-left: auto; }
}
.aset-body { display: flex; flex-direction: column; gap: 8px; padding: 10px; }
.aset-list { display: flex; flex-wrap: wrap; gap: 6px; }
.aset-item { border: 1px solid var(--border); background: var(--btn); color: var(--text-dim); border-radius: 6px; padding: 4px 10px; cursor: pointer;
  &.active { border-color: var(--accent); background: var(--bg-active); color: var(--text); } }
.aset-flag { margin-left: 6px; font-size: 11px; color: var(--ok); }
.aset-actions { display: flex; gap: 6px; flex-wrap: wrap;
  button { border: 1px solid var(--border); background: var(--btn); color: var(--text-dim); border-radius: 6px; padding: 4px 10px; cursor: pointer;
    &:hover:not(:disabled) { background: var(--btn-hover); color: var(--text); }
    &:disabled { opacity: 0.45; cursor: default; } } }
label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-dim);
  input, textarea { border: 1px solid var(--border); border-radius: 6px; background: var(--bg-input); color: var(--text); padding: 6px 8px; font: inherit; resize: vertical;
    &:focus { outline: none; border-color: var(--accent); } } }
.aset-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.aset-keyrow { display: flex; gap: 6px; input { flex: 1; } button { flex: none; border: 1px solid var(--border); background: var(--btn); color: var(--text-dim); border-radius: 6px; cursor: pointer; &:hover { background: var(--btn-hover); color: var(--text); } } }
.aset-activate { align-self: flex-start; border: 1px solid var(--accent); background: var(--bg-active); color: var(--text); border-radius: 6px; padding: 6px 12px; cursor: pointer; }
</style>
