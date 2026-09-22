// nlu 纯逻辑单测：拆解质量守门 / 单元指令文案 / 单元循环 / 落库摘要往返。
// 无 vi.mock：runOnce 依赖注入（tve-unit-testing 注入风格）。
import { describe, expect, it } from "vitest";
import type { BrainDecomposition, BrainKnowledgeHit, BrainTaskUnit } from "../lib/api";
import {
  decomposeDigest,
  knowledgeNote,
  parseStoredDecomposition,
  runUnitPlan,
  unitInstruction,
  usablePlan,
  type UnitRunDeps,
} from "./nlu";

function hit(id: string, label: string): BrainKnowledgeHit {
  return { id, label };
}

function unit(index: number, text: string, method: string | null, refs: BrainKnowledgeHit[] = []): BrainTaskUnit {
  return { index, text, method, source: method ? "lexicon" : null, zone: method ? "yellow" : null, phase: "act", refs };
}

function deco(units: BrainTaskUnit[]): BrainDecomposition {
  return { task: "T", units, traces: [{ stage: "语义解析", detail: "ok" }], refs: [] };
}

describe("usablePlan 拆解质量守门", () => {
  it("正常：两个以上单元且过半有预测 → 可用", () => {
    const units = [unit(1, "建项目", "project.create"), unit(2, "打开", "project.open"), unit(3, "随意", null)];
    expect(usablePlan(deco(units))).toEqual(units);
  });

  it("边界：恰好两个单元、全部有预测 → 可用", () => {
    const units = [unit(1, "a", "asset.list"), unit(2, "b", "asset.read")];
    expect(usablePlan(deco(units))).toHaveLength(2);
  });

  it("异常：null / 空单元 / 单单元 → 回落", () => {
    expect(usablePlan(null)).toBeNull();
    expect(usablePlan(deco([]))).toBeNull();
    expect(usablePlan(deco([unit(1, "只有一段", "project.create")]))).toBeNull();
  });

  it("异常：预测不足两个 → 回落（纯闲聊拆解不驱动助手）", () => {
    const units = [unit(1, "你好", null), unit(2, "讲个笑话", null)];
    expect(usablePlan(deco(units))).toBeNull();
  });

  it("边界：超过 8 单元 → 回落（碎片化保护）", () => {
    const units = Array.from({ length: 9 }, (_, i) => unit(i + 1, `s${i}`, "asset.list"));
    expect(usablePlan(deco(units))).toBeNull();
  });
});

describe("unitInstruction 单元指令", () => {
  it("正常：含序号进度、阶段、预测入口与只做本单元约束", () => {
    const msg = unitInstruction(unit(2, "打开项目", "project.open"), [], 3);
    expect(msg).toContain("语义单元 2/3");
    expect(msg).toContain("打开项目");
    expect(msg).toContain("project.open");
    expect(msg).toContain("只完成当前单元");
  });

  it("边界：无预测方法时不出现入口行", () => {
    const msg = unitInstruction(unit(1, "你好", null), [], 1);
    expect(msg).not.toContain("预测入口");
  });

  it("正常：已完成摘要进入指令且标注不要重复", () => {
    const msg = unitInstruction(unit(2, "b", "asset.list"), ["a → 完成"], 2);
    expect(msg).toContain("不要重复执行");
    expect(msg).toContain("- a → 完成");
  });

  it("正常：图谱参考进入指令提示深查；无参考不出现该行", () => {
    const withRefs = unitInstruction(
      unit(1, "写一个tween动画脚本", "asset.write", [
        hit("skill:tve-sdk-scripting", "tve 脚本编写"),
        hit("concept:doc:sdk/tween.md", "tween 补间动画"),
      ]),
      [],
      1,
    );
    expect(withRefs).toContain("大脑知识命中");
    expect(withRefs).toContain('load_skill({"id": "tve-sdk-scripting"})');
    expect(withRefs).toContain('load_doc({"id": "sdk/tween.md"})');
    expect(withRefs).toContain("不要凭记忆猜测");
    // 目录式注入：不预载任何内容
    expect(withRefs).not.toContain("声明式补间 API");
    expect(unitInstruction(unit(1, "随便做", null), [], 1)).not.toContain("大脑知识命中");
  });

  it("正常：knowledgeNote 直通注入（技能给 id、文档给入口；空命中为空串）", () => {
    const deco2 = deco([
      unit(1, "a", null),
      unit(2, "b", null),
    ]);
    const note = knowledgeNote({
      ...deco2,
      refs: [hit("skill:tve-sdk-scripting", "tve 脚本编写")],
    });
    expect(note).toContain("大脑知识命中");
    expect(note).toContain("load_skill");
    expect(knowledgeNote(deco2)).toBe("");
  });
});

describe("runUnitPlan 单元循环", () => {
  function deps(log: string[], replies: string[], stopAfter = -1): UnitRunDeps & { events: string[] } {
    return {
      events: log,
      runOnce: async (extra) => {
        log.push(`run:${extra[0]?.content ?? ""}`);
        return { content: replies[log.filter((l) => l.startsWith("run:")).length - 1] ?? "", toolCalls: [] };
      },
      onUnitStart: (i) => log.push(`start:${i}`),
      onUnitDone: (i) => log.push(`done:${i}`),
      shouldStop: () =>
        stopAfter >= 0 && log.filter((l) => l.startsWith("start:")).length === stopAfter + 1,
    };
  }

  it("正常：逐单元推进，doneNotes 串入后续指令", async () => {
    const log: string[] = [];
    const units = [unit(1, "a", "x.a"), unit(2, "b", "x.b")];
    const d = deps(log, ["第一完成", "第二完成"]);
    const r = await runUnitPlan(units, d);
    expect(r.stopped).toBe(false);
    expect(r.completed).toBe(2);
    expect(log.filter((l) => l.startsWith("start:"))).toEqual(["start:1", "start:2"]);
    expect(log.filter((l) => l.startsWith("done:"))).toEqual(["done:1", "done:2"]);
    expect(r.reply.content).toBe("第二完成");
    // 第二单元的指令带进度与第一单元结果摘要（跨单元衔接）
    const second = log.find((l) => l.includes("语义单元 2/2")) ?? "";
    expect(second).toContain("第一完成");
    expect(second).toContain("不要重复执行");
  });

  it("异常：shouldStop 中断 → 返回停止文案与完成数", async () => {
    const log: string[] = [];
    const units = [unit(1, "a", "x.a"), unit(2, "b", "x.b")];
    const d = deps(log, ["一"], 0); // 第 2 单元开始前停
    const r = await runUnitPlan(units, d);
    expect(r.stopped).toBe(true);
    expect(r.completed).toBe(1);
    expect(r.reply.content).toContain("已按要求停止");
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
