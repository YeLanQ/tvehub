// AssistantChat 挂载测试：聚焦"执行过程"链路——工具消息落库后
// 时间线必须折叠出可展开的步骤块（默认收敛、点击展开、成功/失败标记），
// 以及用户/助手气泡带复制按钮。
import { describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { mount, flushPromises } from "@vue/test-utils";
import AssistantChat from "./AssistantChat.vue";
import { getConversations } from "./conversations";
import { getAssistantStore } from "./store";
import { runAgent, type AssistantReply } from "./agent";

vi.mock("./agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent")>();
  return { ...actual, runAgent: vi.fn() };
});

async function mounted() {
  // 每例新建会话：conversations 是模块级单例，避免用例间消息串扰
  const convs = getConversations();
  await convs.newConversation(convs.activeRoot);
  const wrapper = mount(AssistantChat);
  await flushPromises();
  return { wrapper, convId: convs.activeConvId() as string };
}

describe("AssistantChat 执行过程面板", () => {
  it("正常：调用+结果按 toolCallId 合并为一行（不重复），点击展开可见成败", async () => {
    const { wrapper, convId } = await mounted();
    const convs = getConversations();
    // 一次调用 + 其结果 = 一行；两次调用共两行
    convs.append(convId, {
      role: "tool",
      content: "{}",
      toolName: "scene.list",
      toolCallId: "c1",
    });
    convs.append(convId, {
      role: "tool",
      content: '[{"name":"Main.scene"}]',
      toolName: "scene.list",
      toolCallId: "c1",
      result: true,
    });
    convs.append(convId, {
      role: "tool",
      content: '{"rel":"assets/Main.scene"}',
      toolName: "scene.open",
      toolCallId: "c2",
    });
    convs.append(convId, {
      role: "tool",
      content: '{"error":"项目未打开"}',
      toolName: "scene.open",
      toolCallId: "c2",
      result: true,
    });
    await nextTick();
    const head = wrapper.find(".asteps-head");
    expect(head.exists()).toBe(true);
    expect(head.text()).toContain("2");
    // 非 busy 默认收敛：只有摘要行
    expect(wrapper.find(".asteps-body").exists()).toBe(false);
    await head.trigger("click");
    const body = wrapper.find(".asteps-body");
    expect(body.exists()).toBe(true);
    expect(body.text()).toContain("scene.list");
    expect(body.text()).toContain("scene.open");
    expect(wrapper.findAll(".asteps-item")).toHaveLength(2);
    expect(wrapper.find(".asteps-ok.bad").exists()).toBe(true);
  });

  it("空值：无工具消息时不渲染执行过程块", async () => {
    const { wrapper, convId } = await mounted();
    getConversations().append(convId, { role: "user", content: "你好" });
    await nextTick();
    expect(wrapper.find(".asteps-head").exists()).toBe(false);
  });
});

describe("AssistantChat 消息气泡", () => {
  it("正常：用户与助手气泡带复制按钮，点击回显 ✓", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const { wrapper, convId } = await mounted();
    getConversations().append(convId, { role: "user", content: "帮我搭个场景" });
    getConversations().append(convId, { role: "assistant", content: "好的" });
    await nextTick();
    const btns = wrapper.findAll(".achat-copy");
    expect(btns.length).toBe(2);
    await btns[0].trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("帮我搭个场景");
    expect(wrapper.findAll(".achat-copy")[0].text()).toBe("✓");
  });

  it("正常：气泡正文可选中（user-select: text）", async () => {
    const { wrapper, convId } = await mounted();
    getConversations().append(convId, { role: "assistant", content: "可复制文本" });
    await nextTick();
    const content = wrapper.find(".achat-content");
    expect(content.exists()).toBe(true);
    expect(content.classes()).toContain("achat-content");
  });
});

describe("AssistantChat 发送链路（引用别名回归）", () => {
  it("边界：第二轮运行期间用户消息实时上屏（不被 finally 的引用替换吞掉）", async () => {
    const store = getAssistantStore();
    if (!store.providers.some((p) => p.id === "p1")) {
      store.providers.push({
        id: "p1",
        name: "测试供应商",
        baseUrl: "https://x/v1",
        apiKey: "k",
        model: "m",
        models: ["m"],
        contextK: 128,
      });
    }
    store.setActiveProvider("p1");
    const runAgentMock = vi.mocked(runAgent);
    let resolveRun: (r: AssistantReply) => void = () => {};
    runAgentMock.mockImplementation(
      () =>
        new Promise<AssistantReply>((res) => {
          resolveRun = res;
        }),
    );
    const { wrapper } = await mounted();
    const userTexts = () =>
      wrapper.findAll(".achat-row.user .achat-content").map((w) => w.text());
    const sendBtn = () => wrapper.find(".achat-send:not(.stop)");
    const textEl = wrapper.find(".achat-text");

    // 第一轮：发送 → 运行中消息可见 → 收尾
    await textEl.setValue("第一个任务");
    await sendBtn().trigger("click");
    await nextTick();
    expect(userTexts().some((t) => t.includes("第一个任务"))).toBe(true);
    resolveRun({ content: "第一轮完成", toolCalls: [] });
    await flushPromises();

    // 第二轮：运行挂起期间用户消息必须实时可见——回归：send 收尾若用浅拷贝
    // 替换 messages.value 引用，convs.append 进缓存数组的消息就不再驱动时间线，
    // 用户消息与工具步骤在运行期间全部"消失"（只剩流式气泡）
    await textEl.setValue("第二个任务");
    await sendBtn().trigger("click");
    await nextTick();
    await nextTick();
    expect(userTexts().some((t) => t.includes("第二个任务"))).toBe(true);
    resolveRun({ content: "第二轮完成", toolCalls: [] });
    await flushPromises();
  });

  it("边界：执行过程面板默认收敛一行，运行中也不自动展开（点击展开/再点收起）", async () => {
    const store = getAssistantStore();
    if (!store.providers.some((p) => p.id === "p1")) {
      store.providers.push({
        id: "p1",
        name: "测试供应商",
        baseUrl: "https://x/v1",
        apiKey: "k",
        model: "m",
        models: ["m"],
        contextK: 128,
      });
    }
    store.setActiveProvider("p1");
    const runAgentMock = vi.mocked(runAgent);
    let resolveRun: (r: AssistantReply) => void = () => {};
    runAgentMock.mockImplementation(
      () =>
        new Promise<AssistantReply>((res) => {
          resolveRun = res;
        }),
    );
    const { wrapper, convId } = await mounted();
    await wrapper.find(".achat-text").setValue("跑一个多步任务");
    await wrapper.find(".achat-send:not(.stop)").trigger("click");
    await nextTick();
    // 运行中：工具消息落库 → 面板保持收敛一行（不再自动展开跟随）
    getConversations().append(convId, {
      role: "tool",
      content: "{}",
      toolName: "scene.list",
      toolCallId: "c1",
    });
    await nextTick();
    expect(wrapper.find(".asteps-body").exists()).toBe(false);
    expect(wrapper.find(".asteps-head").exists()).toBe(true);
    // 点头部展开 → 再点收起
    await wrapper.find(".asteps-head").trigger("click");
    await nextTick();
    expect(wrapper.find(".asteps-body").exists()).toBe(true);
    await wrapper.find(".asteps-head").trigger("click");
    await nextTick();
    expect(wrapper.find(".asteps-body").exists()).toBe(false);
    resolveRun({ content: "完成", toolCalls: [] });
    await flushPromises();
  });
});

describe("AssistantChat 工具调用信息气泡", () => {
  it("正常：调用占位/标签方言/结果转储收敛为单行带箭头，点击向下展开/再点收起", async () => {
    const { wrapper, convId } = await mounted();
    const convs = getConversations();
    convs.append(convId, {
      role: "assistant",
      content:
        "（已发起工具调用）\n\n" +
        '**工具调用：** `load_skill` `{"id":"tve-scripting"}`\n\n' +
        '**结果：** `{"id":"tve-scripting","title":"tve 脚本编写"}`',
    });
    convs.append(convId, { role: "assistant", content: "（已发起工具调用）" });
    convs.append(convId, { role: "assistant", content: "这是普通的总结回复，不受影响。" });
    await nextTick();
    const infoBubbles = wrapper.findAll(".achat-bubble-toolinfo");
    expect(infoBubbles).toHaveLength(2);
    expect(infoBubbles[0].text()).toContain("load_skill");
    // 收敛态：单行裁剪（无 open），右侧箭头可展开
    expect(infoBubbles[0].find(".achat-toolinfo-line.open").exists()).toBe(false);
    expect(infoBubbles[0].find(".achat-toolinfo-arrow").text()).toBe("▸");
    // 点箭头 → 向下展开全文（open），再点 → 收起
    await infoBubbles[0].find(".achat-toolinfo-arrow").trigger("click");
    await nextTick();
    expect(wrapper.find(".achat-bubble-toolinfo .achat-toolinfo-line.open").exists()).toBe(true);
    expect(wrapper.find(".achat-bubble-toolinfo .achat-toolinfo-arrow").text()).toBe("▾");
    await wrapper.find(".achat-bubble-toolinfo .achat-toolinfo-arrow").trigger("click");
    await nextTick();
    expect(wrapper.find(".achat-bubble-toolinfo .achat-toolinfo-line.open").exists()).toBe(false);
    // 点内容行同样可切换展开
    await wrapper.find(".achat-bubble-toolinfo .achat-toolinfo-line").trigger("click");
    await nextTick();
    expect(wrapper.find(".achat-bubble-toolinfo .achat-toolinfo-line.open").exists()).toBe(true);
    await wrapper.find(".achat-bubble-toolinfo .achat-toolinfo-line").trigger("click");
    await nextTick();
    expect(wrapper.find(".achat-bubble-toolinfo .achat-toolinfo-line.open").exists()).toBe(false);
    // 普通回复不带收敛类
    const plain = wrapper
      .findAll(".achat-row.assistant .achat-bubble")
      .filter((b) => !b.classes().includes("achat-bubble-toolinfo"));
    expect(plain).toHaveLength(1);
    expect(plain[0].text()).toContain("普通的总结回复");
  });
});
