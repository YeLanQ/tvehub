// nlu 纯逻辑单测：拆解质量守门 / 计划注入 / 落库摘要往返。
// 无 vi.mock：依赖注入（tve-unit-testing 注入风格）。
import { describe, expect, it } from "vitest";
import type { BrainDecomposition, BrainKnowledgeHit, BrainTaskUnit } from "../lib/api";
import {
  decomposeDigest,
  knowledgeNote,
  parseStoredDecomposition,
  planNote,
} from "./nlu";

function hit(id: string, label: string): BrainKnowledgeHit {
  return { id, label };
}

function unit(
  index: number,
  text: string,
  method: string | null,
  refs: BrainKnowledgeHit[] = [],
  params: Record<string, unknown> | null = null,
): BrainTaskUnit {
  return {
    index,
    text,
    method,
    source: method ? "lexicon" : null,
    zone: method ? "yellow" : null,
    phase: "act",
    refs,
    exec: "assist",
    params,
  };
}

function deco(units: BrainTaskUnit[]): BrainDecomposition {
  return { task: "T", units, traces: [{ stage: "语义解析", detail: "ok" }], refs: [] };
}

describe("planNote 执行计划注入", () => {
  it("正常：单元逐行列出，含建议工具/建议参数/知识参考", () => {
    const note = planNote([
      unit(1, "创建一个3D项目", "project.create", [], { name: "aixosp" }),
      unit(2, "添加一个方向光", "node.add", [hit("concept:doc:sdk/tween.md", "tween 补间动画")]),
    ]);
    expect(note).toContain("拆解为 2 个单元任务");
    expect(note).toContain("单元 1（建议工具：project.create）");
    expect(note).toContain('{"name":"aixosp"}');
    expect(note).toContain("tween 补间动画");
    expect(note).toContain("「任务完成」开头");
  });

  it("边界：无建议参数/参考时不出现对应行", () => {
    const note = planNote([unit(1, "随便做做", null)]);
    expect(note).not.toContain("建议参数");
    expect(note).not.toContain("知识参考");
    expect(note).toContain("自行选择");
  });
});

describe("knowledgeNote 直通注入", () => {
  it("正常：技能给 id、文档给入口；空命中为空串", () => {
    const d = deco([unit(1, "a", null), unit(2, "b", null)]);
    const note = knowledgeNote({ ...d, refs: [hit("skill:tve-sdk-scripting", "tve 脚本编写")] });
    expect(note).toContain("大脑知识命中");
    expect(note).toContain("load_skill");
    expect(note).not.toContain("load_doc");
    expect(knowledgeNote(d)).toBe("");
    const withDoc = knowledgeNote({
      ...d,
      refs: [hit("concept:doc:sdk/tween.md", "tween 补间动画")],
    });
    expect(withDoc).toContain('load_doc({"id": "sdk/tween.md"})');
  });

  it("工坊资源命中给 load_repo 入口（<分类>/<文件名>）", () => {
    const d = deco([unit(1, "a", null)]);
    const note = knowledgeNote({
      ...d,
      refs: [hit("concept:repos:code/Rotator.ts", "Rotator")],
    });
    expect(note).toContain("工坊资源「Rotator」");
    expect(note).toContain('load_repo({"id": "code/Rotator.ts"})');
  });
});

describe("decomposeDigest / parseStoredDecomposition 落库往返", () => {
  it("正常：digest 后可解析还原 units 与 traces", () => {
    const d = deco([unit(1, "a", "x.a")]);
    const parsed = parseStoredDecomposition(decomposeDigest(d));
    expect(parsed?.units).toHaveLength(1);
    expect(parsed?.units[0]?.method).toBe("x.a");
    expect(parsed?.traces[0]?.stage).toBe("语义解析");
  });

  it("异常：非 JSON / 无 units 结构 → null", () => {
    expect(parseStoredDecomposition("普通文本结果")).toBeNull();
    expect(parseStoredDecomposition('{"foo":1}')).toBeNull();
    expect(parseStoredDecomposition('{"units":"broken"}')).toBeNull();
  });
});
