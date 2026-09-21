// AssistantChat 挂载测试：聚焦"执行过程"链路——工具消息落库后
// 时间线必须折叠出可展开的步骤块（默认收敛、点击展开、成功/失败标记），
// 以及用户/助手气泡带复制按钮。
import { describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { mount, flushPromises } from "@vue/test-utils";
import AssistantChat from "./AssistantChat.vue";
import { getConversations } from "./conversations";

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
