import { beforeEach, describe, expect, it } from "vitest";
import { getAssistantStore, resetAssistantStore, type AiProvider } from "./store";

// jsdom 无 Tauri：ui-state 空转 → 纯内存路径；单例用 resetAssistantStore 复位。

function makeProvider(partial: Partial<AiProvider> = {}): Partial<AiProvider> {
  return { name: "测试端点", baseUrl: "https://example.com/v1", model: "m1", ...partial };
}

describe("assistant store（卡片）", () => {
  beforeEach(() => resetAssistantStore());

  it("正常：首访带默认卡片并自动激活", () => {
    const s = getAssistantStore();
    expect(s.cards).toHaveLength(1);
    expect(s.activeCardId).toBe(s.cards[0].id);
    expect(s.activeCard?.name).toBe("TvE 助手");
  });

  it("正常：create/update/duplicate 更新内容并触及 updatedAt", () => {
    const s = getAssistantStore();
    const card = s.createCard({ name: "写手", persona: "负责润色" });
    expect(s.cards.map((c) => c.name)).toContain("写手");
    s.updateCard(card.id, { persona: "负责写代码" });
    expect(s.cards.find((c) => c.id === card.id)?.persona).toBe("负责写代码");
    const copy = s.duplicateCard(card.id);
    expect(copy?.name).toBe("写手 副本");
    expect(copy?.id).not.toBe(card.id);
  });

  it("边界：deleteCard 保底至少一张；删除激活卡后自动切到剩余卡", () => {
    const s = getAssistantStore();
    const first = s.cards[0].id;
    s.deleteCard(first);
    expect(s.cards).toHaveLength(1);
    const extra = s.createCard({ name: "可删" });
    s.setActiveCard(extra.id);
    s.deleteCard(extra.id);
    expect(s.activeCardId).toBe(s.cards[0].id);
  });

  it("空值：操作未知 id 静默无副作用", () => {
    const s = getAssistantStore();
    s.updateCard("nope", { name: "x" });
    s.setActiveCard("nope");
    s.deleteCard("nope");
    expect(s.duplicateCard("nope")).toBeNull();
    expect(s.cards).toHaveLength(1);
  });
});

describe("assistant store（供应商）", () => {
  beforeEach(() => resetAssistantStore());

  it("正常：首个供应商自动激活；切换与删除回退", () => {
    const s = getAssistantStore();
    const a = s.createProvider(makeProvider());
    const b = s.createProvider(makeProvider({ name: "第二端点" }));
    expect(s.activeProviderId).toBe(a.id);
    s.setActiveProvider(b.id);
    expect(s.activeProvider?.name).toBe("第二端点");
    s.deleteProvider(b.id);
    expect(s.activeProviderId).toBe(a.id);
    s.deleteProvider(a.id);
    expect(s.activeProvider).toBeNull();
    expect(s.activeProviderId).toBe("");
  });

  it("正常：新供应商默认上下文窗口 128K，可改为 1M", () => {
    const s = getAssistantStore();
    const p = s.createProvider(makeProvider());
    expect(s.providers[0].contextK).toBe(128);
    s.updateProvider(p.id, { contextK: 1024 });
    expect(s.activeProvider?.contextK).toBe(1024);
  });

  it("异常：updateProvider 未知 id 静默；setActiveProvider 未知 id 不生效", () => {
    const s = getAssistantStore();
    const p = s.createProvider(makeProvider());
    s.updateProvider("nope", { model: "x" });
    s.setActiveProvider("nope");
    expect(s.activeProviderId).toBe(p.id);
    expect(s.providers[0].model).toBe("m1");
  });
});
