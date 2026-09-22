// tools 纯函数单测：工作区 root 注入与大脑决策中心回执 → 工具结果转换。
// 执行编排（brainExecute/确认回路）依赖 Tauri invoke，不在单测面；
// 这里锁定的是回喂模型的 { error } 语义——模型自纠与救援逻辑都靠它。

import { describe, expect, it } from "vitest";
import { injectWorkspaceRoot, outcomeToToolResult, ROOT_METHODS } from "./tools";
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

  it("边界：ROOT_METHODS 目录与 tools 目录一致（scene/asset 四方法）", () => {
    expect([...ROOT_METHODS].sort()).toEqual(
      ["asset.list", "asset.read", "asset.write", "scene.list"].sort(),
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
