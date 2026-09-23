// tools 纯函数单测：工作区 root 注入与大脑决策中心回执 → 工具结果转换。
// 执行编排（brainExecute/确认回路）依赖 Tauri invoke，不在单测面；
// 这里锁定的是回喂模型的 { error } 语义——模型自纠与救援逻辑都靠它。

import { describe, expect, it } from "vitest";
import {
  injectWorkspaceRoot,
  normalizeNodeAddArgs,
  outcomeToToolResult,
  parseAssistantSkill,
  rewriteScriptAttach,
  ROOT_METHODS,
} from "./tools";
import { SKILLS, type AssistantSkill } from "./skills";
import type { BrainExecOutcome } from "../lib/api";

function outcome(patch: Partial<BrainExecOutcome>): BrainExecOutcome {
  return {
    status: "ok",
    decision: "autoExecute",
    zone: "green",
    reason: "",
    ratio: 1,
    result: null,
    ...patch,
  };
}

describe("injectWorkspaceRoot", () => {
  it("正常：目录类方法未显式指定 root 时注入当前工作区", () => {
    expect(injectWorkspaceRoot("asset.read", { path: "a.txt" }, "D:/proj")).toEqual({
      path: "a.txt",
      root: "D:/proj",
    });
    expect(injectWorkspaceRoot("scene.list", {}, "D:/proj")).toEqual({ root: "D:/proj" });
  });

  it("正常：调用方显式指定的 root 优先，不覆盖", () => {
    expect(
      injectWorkspaceRoot("asset.list", { root: "E:/other" }, "D:/proj"),
    ).toEqual({ root: "E:/other" });
  });

  it("边界：非目录类方法与无工作区时不注入", () => {
    expect(injectWorkspaceRoot("node.add", { kind: "mesh" }, "D:/proj")).toEqual({
      kind: "mesh",
    });
    expect(injectWorkspaceRoot("asset.write", { path: "a" })).toEqual({ path: "a" });
    expect(injectWorkspaceRoot("asset.write", {}, "")).toEqual({});
  });

  it("边界：ROOT_METHODS 目录与 tools 目录一致（scene/asset/file 方法）", () => {
    expect([...ROOT_METHODS].sort()).toEqual(
      ["asset.list", "asset.read", "asset.write", "file.index", "file.search", "file.module", "scene.list", "scene.write"].sort(),
    );
  });
});

describe("outcomeToToolResult", () => {
  it("正常：ok 回执透传 result", () => {
    const result = [{ name: "Main.scene" }];
    expect(outcomeToToolResult(outcome({ result }), "scene.list")).toBe(result);
  });

  it("正常：denied 回执转为含原因的 error 结构（模型可读）", () => {
    const out = outcomeToToolResult(
      outcome({ status: "denied", decision: "deny", reason: "红灯操作" }),
      "system.rm",
    );
    expect(out).toHaveProperty("error");
    expect((out as { error: string }).error).toContain("拒绝");
    expect((out as { error: string }).error).toContain("红灯操作");
  });

  it("边界：needConfirm（无确认回调）转为需确认 error，不静默丢弃", () => {
    const out = outcomeToToolResult(
      outcome({ status: "needConfirm", decision: "needConfirm", reason: "写操作需批准" }),
      "asset.write",
    );
    expect(out).toHaveProperty("error");
    const msg = (out as { error: string }).error;
    expect(msg).toContain("asset.write");
    expect(msg).toContain("写操作需批准");
  });

  it("空值：ok 但缺 result 时按回执异常处理，不返回 undefined", () => {
    const out = outcomeToToolResult(outcome({ result: undefined }), "editor.state");
    expect(out).toHaveProperty("error");
  });
});

describe("normalizeNodeAddArgs", () => {
  it("正常：rel 与 subtype 互补（脚本 rel 同时落 subtype，细分 subtype 同时落 rel）", () => {    expect(normalizeNodeAddArgs({ kind: "script", rel: "src/Player.ts" })).toEqual({
      kind: "script",
      rel: "src/Player.ts",
      subtype: "src/Player.ts",
    });
    expect(normalizeNodeAddArgs({ kind: "mesh", subtype: "box" })).toEqual({
      kind: "mesh",
      subtype: "box",
      rel: "box",
    });
  });

  it("正常：parent 归一为 parentId；已有 parentId 时 parent 让位", () => {
    expect(normalizeNodeAddArgs({ kind: "group", parent: "node_a" })).toEqual({
      kind: "group",
      parentId: "node_a",
    });
    expect(normalizeNodeAddArgs({ kind: "group", parent: "a", parentId: "b" })).toEqual({
      kind: "group",
      parent: "a",
      parentId: "b",
    });
  });

  it("边界：name 半角/全角逗号截断与空白清理；空名删除", () => {
    expect(normalizeNodeAddArgs({ kind: "camera", name: "跟随相机, 弹性跟随" }).name).toBe(
      "跟随相机",
    );
    expect(normalizeNodeAddArgs({ kind: "camera", name: "主相机，子描述" }).name).toBe("主相机");
    expect("name" in normalizeNodeAddArgs({ kind: "camera", name: " , " })).toBe(false);
    expect(normalizeNodeAddArgs({ kind: "camera", name: " 玩家 " }).name).toBe("玩家");
  });

  it("边界：无 rel/subtype 的普通参数原样透传；已有双方时不互写", () => {
    expect(normalizeNodeAddArgs({ kind: "group" })).toEqual({ kind: "group" });
    const both = normalizeNodeAddArgs({ kind: "light", subtype: "point", rel: "x" });
    expect(both).toEqual({ kind: "light", subtype: "point", rel: "x" });
  });
});

describe("rewriteScriptAttach 脚本挂载语义改写", () => {
  it("正常：kind=script 子节点形态改写为节点挂脚本组件", () => {
    expect(
      rewriteScriptAttach("node.add", { kind: "script", rel: "src/Player.ts", parentId: "cube_1" }),
    ).toEqual({ name: "node.component.add", params: { id: "cube_1", script: "src/Player.ts" } });
    // parent 别名与 path/subtype 路径别名都收
    const viaParent = rewriteScriptAttach("node.add", {
      kind: "scriptnode",
      subtype: "src/A.ts",
      parent: "root",
    });
    expect(viaParent).toEqual({ name: "node.component.add", params: { id: "root", script: "src/A.ts" } });
  });

  it("边界：缺目标节点或脚本路径 → 教学错误（组件语义而非子节点）", () => {
    const missTarget = rewriteScriptAttach("node.add", { kind: "script", rel: "src/A.ts" });
    expect("error" in missTarget).toBe(true);
    expect(String((missTarget as { error: string }).error)).toContain("node.component.add");
    const missScript = rewriteScriptAttach("node.add", { kind: "script", parentId: "n1" });
    expect("error" in missScript).toBe(true);
  });

  it("边界：非脚本形态与其他方法原样透传", () => {
    expect(rewriteScriptAttach("node.add", { kind: "mesh", subtype: "box", parentId: "p" })).toEqual({
      name: "node.add",
      params: { kind: "mesh", subtype: "box", parentId: "p" },
    });
    expect(rewriteScriptAttach("node.set", { id: "n", name: "x" })).toEqual({
      name: "node.set",
      params: { id: "n", name: "x" },
    });
  });
});

describe("parseAssistantSkill", () => {
  const reg = SKILLS as AssistantSkill[];

  it("正常：显式 id 优先（不做任何推断）", () => {
    expect(parseAssistantSkill("tve-scripting", "随便", reg)).toBe("tve-scripting");
  });

  it("正常：空 id 时按任务关键词路由到对应技能（脚本任务 → tve-scripting）", () => {
    expect(
      parseAssistantSkill(undefined, "写一个角色移动脚本 onupdate 里读输入", reg),
    ).toBe("tve-scripting");
  });

  it("边界：路由未命中时按词元匹配 id，再兜底注册表首项", () => {
    const tiny: AssistantSkill[] = [
      { id: "alpha", name: "A", description: "无关键词", body: "" } as unknown as AssistantSkill,
      { id: "beta", name: "B", description: "无关键词", body: "" } as unknown as AssistantSkill,
    ];
    expect(parseAssistantSkill("", "讲讲 alpha 的内容", tiny)).toBe("alpha");
    expect(parseAssistantSkill(null, "无关内容 xyzzy", tiny)).toBe("alpha");
  });

  it("空值：注册表为空返回空串（调用方按未知技能处理）", () => {
    expect(parseAssistantSkill(null, "任意任务", [])).toBe("");
  });
});
