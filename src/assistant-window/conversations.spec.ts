import { describe, expect, it } from "vitest";
import { getConversations } from "./conversations";

// 单例 store：用互不相同的伪项目根隔离用例，避免相互串扰（jsdom 下 ui-state
// 全部空转 → 纯内存路径）。消息读取走公开 API ensureActiveMessages()——它返回
// 的就是内部缓存数组的引用，append 的写入会体现在同一数组上。

async function open(root: string) {
  const convs = getConversations();
  await convs.switchProject(root);
  const messages = await convs.ensureActiveMessages();
  return { convs, messages };
}

describe("conversations 会话工作区（按项目隔离）", () => {
  it("正常：ensureActiveMessages 自动建首个会话并返回可追加的消息数组", async () => {
    const { convs, messages } = await open("P:/a");
    expect(messages).toHaveLength(0);
    const convId = convs.activeConvId() as string;
    const added = convs.append(convId, { role: "user", content: "你好" });
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("你好");
    expect(added.id).toBeTruthy();
    expect(added.createdAt).toBeGreaterThan(0);
  });

  it("正常：不同项目的工作区互不可见（隔离）", async () => {
    const { convs, messages } = await open("P:/iso-1");
    convs.append(convs.activeConvId() as string, { role: "user", content: "一号项目" });
    expect(messages).toHaveLength(1);
    const firstConvId = convs.activeConvId() as string;
    const other = await open("P:/iso-2");
    expect(other.convs.activeConvId()).not.toBe(firstConvId);
    expect(other.convs.convs().find((c) => c.id === firstConvId)).toBeUndefined();
    expect(other.messages).toHaveLength(0);
  });

  it("边界：newConversation 新建并切换；旧会话保留在清单", async () => {
    const { convs, messages } = await open("P:/multi");
    const first = convs.activeConvId() as string;
    convs.append(first, { role: "user", content: "旧会话内容" });
    const second = await convs.newConversation("P:/multi", "专项讨论");
    expect(convs.activeConvId()).toBe(second);
    const fresh = await convs.ensureActiveMessages();
    expect(fresh).toHaveLength(0);
    expect(convs.convs().map((c) => c.id)).toContain(first);
    expect(convs.convs().find((c) => c.id === second)?.title).toBe("专项讨论");
    void messages;
  });

  it("正常：pruneMissing 清掉已删除项目的工作区，其余与通用区不受影响", async () => {
    const dead = await open("P:/dead-proj");
    dead.convs.append(dead.convs.activeConvId() as string, { role: "user", content: "将随项目消失" });
    const alive = await open("P:/alive-proj");
    alive.convs.append(alive.convs.activeConvId() as string, { role: "user", content: "保留" });
    const convs = alive.convs;
    // 探测口径注入：仅 P:/dead-proj 已消失
    const gone = await convs.pruneMissing(async (root) => root !== "P:/dead-proj");
    expect(gone).toEqual(["P:/dead-proj"]);
    expect(convs.convsOf("P:/dead-proj")).toEqual([]);
    expect(convs.convsOf("P:/alive-proj").length).toBeGreaterThan(0);
  });

  it("边界：激活工作区被清理时回落通用；无消失项目时索引原样", async () => {
    const dying = await open("P:/dying");
    const fallen = await dying.convs.pruneMissing(async (root) => root !== "P:/dying");
    expect(fallen).toEqual(["P:/dying"]);
    expect(dying.convs.activeRoot).toBe("");
    expect(dying.convs.convs().length).toBeGreaterThan(0);

    const { convs } = await open("P:/keep");
    const before = JSON.stringify(convs.index.projects["P:/keep"]);
    expect(await convs.pruneMissing(async () => true)).toEqual([]);
    expect(JSON.stringify(convs.index.projects["P:/keep"])).toBe(before);
  });

  it("正常：convsOf/activeConvIdOf 按工作区读取（会话树数据源）", async () => {
    const { convs } = await open("P:/tree-1");
    await convs.newConversation("P:/tree-1");
    const ofA = convs.convsOf("P:/tree-1");
    expect(ofA.length).toBeGreaterThanOrEqual(2);
    expect(convs.convsOf("P:/other")).toEqual([]);
    expect(convs.activeConvIdOf("P:/tree-1")).toBe(convs.activeConvId());
    expect(convs.activeConvIdOf("P:/other")).toBeNull();
  });

  it("异常：remove 移除激活会话后回退到剩余会话；全部移除后为空；未知 id 静默", async () => {
    const { convs } = await open("P:/del");
    const initial = convs.activeConvId() as string;
    const a = (await convs.newConversation("P:/del")) as string;
    const b = (await convs.newConversation("P:/del")) as string;
    convs.remove("P:/del", b);
    expect(convs.activeConvId()).toBe(a);
    convs.remove("P:/del", "不存在");
    convs.remove("P:/del", a);
    expect(convs.activeConvId()).toBe(initial);
    convs.remove("P:/del", initial);
    expect(convs.activeConvId()).toBeNull();
  });

  it("空值：append 到未知会话也安全（建立缓存）；flush 不抛错", () => {
    const convs = getConversations();
    const msg = convs.append("never-created", { role: "user", content: "孤例" });
    expect(msg.id).toBeTruthy();
    expect(() => convs.flush()).not.toThrow();
  });

  it("回归：挂载并发的 ensureActiveMessages 共享建会话（不产出双会话）", async () => {
    const convs = getConversations();
    await convs.switchProject("P:/race");
    // AssistantApp 与 AssistantChat 同时初始化的时序
    const [a, b] = await Promise.all([convs.ensureActiveMessages(), convs.ensureActiveMessages()]);
    expect(a).toBe(b);
    expect(convs.convs()).toHaveLength(1);
  });
});
