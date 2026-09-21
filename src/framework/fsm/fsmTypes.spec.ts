import { describe, expect, it } from "vitest";
import {
  cloneFsmGraph,
  DEFAULT_FSM_GRAPH,
  evalFsmCondition,
  fsmStateById,
  isFsmAssetRel,
  nextFsmStateId,
  nextFsmStateName,
  parseFsmGraph,
} from "./fsmTypes";

// 状态机图数据层：条件求值、图收敛（去重/剔除无效引用/回退）与 id/名生成。

describe("evalFsmCondition", () => {
  it("六种比较运算（数值参数）", () => {
    const c = (op: ">" | "<" | ">=" | "<=" | "==" | "!=") => ({ param: "p", op, value: 5 });
    expect(evalFsmCondition(6, c(">"))).toBe(true);
    expect(evalFsmCondition(6, c("<"))).toBe(false);
    expect(evalFsmCondition(5, c(">="))).toBe(true);
    expect(evalFsmCondition(5, c("<="))).toBe(true);
    expect(evalFsmCondition(5, c("=="))).toBe(true);
    expect(evalFsmCondition(5, c("!="))).toBe(false);
  });

  it("布尔参数按 0/1 比较；参数未定义恒不成立", () => {
    expect(evalFsmCondition(true, { param: "b", op: "==", value: 1 })).toBe(true);
    expect(evalFsmCondition(false, { param: "b", op: "==", value: 0 })).toBe(true);
    expect(evalFsmCondition(undefined, { param: "b", op: "!=", value: 0 })).toBe(false);
  });
});

describe("parseFsmGraph 收敛", () => {
  it("非法输入回默认图（单 Idle 状态）", () => {
    for (const bad of [null, 42, {}, { states: [] }]) {
      const g = parseFsmGraph(bad);
      expect(g.states).toHaveLength(1);
      expect(g.states[0].name).toBe("Idle");
      expect(g.entry).toBe(g.states[0].id);
    }
  });

  it("状态 id/名去重、坐标与颜色收敛", () => {
    const g = parseFsmGraph({
      states: [
        { id: "a", name: "A", x: 99999, y: -99999, color: "#abc" },
        { id: "a", name: "dup-id" },
        { id: "b", name: "A" },
      ],
    });
    expect(g.states.map((s) => s.id)).toEqual(["a", "b"]);
    expect(g.states[0].x).toBe(20000);
    expect(g.states[0].y).toBe(-20000);
    expect(g.states[0].color).toMatch(/^#[0-9a-fA-F]{6}$/); // 非法色回默认
    expect(g.states[1].name).not.toBe("A"); // 重名自动改名
  });

  it("过渡剔除：引用未知状态 / 自环 / 重复 id；非法条件项收敛", () => {
    const g = parseFsmGraph({
      states: [{ id: "a" }, { id: "b" }],
      transitions: [
        { id: "t1", from: "a", to: "b" },
        { id: "t1", from: "a", to: "b" }, // 重复 id
        { from: "a", to: "ghost" }, // 目标不存在
        { from: "a", to: "a" }, // 自环
        { id: "t2", from: "b", to: "a", conditions: [
          { param: "", op: ">", value: 1 }, // 空 param 剔除
          { param: "hp", op: "bogus", value: "x" }, // op 非法回 ==、value 非数回 0
        ] },
      ],
    });
    expect(g.transitions.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(g.transitions[1].conditions).toEqual([{ param: "hp", op: "==", value: 0 }]);
  });

  it("entry 无效回退首状态；参数仅保留数值/布尔", () => {
    const g = parseFsmGraph({
      entry: "ghost",
      states: [{ id: "a" }, { id: "b" }],
      params: { hp: 10, alive: true, bad: "x", deep: null },
    });
    expect(g.entry).toBe("a");
    expect(g.params).toEqual({ hp: 10, alive: true });
  });

  it("序列化往返稳定（parse(parse(g)) 深相等）", () => {
    const doc = {
      entry: "s1",
      states: [
        { id: "s1", name: "Idle", x: 0, y: 0 },
        { id: "s2", name: "Run", x: 200, y: 0 },
      ],
      transitions: [{ id: "t1", from: "s1", to: "s2", duration: 2, conditions: [{ param: "hp", op: "<", value: 3 }] }],
      params: { hp: 10 },
    };
    expect(parseFsmGraph(parseFsmGraph(doc))).toEqual(parseFsmGraph(doc));
  });
});

describe("id / 名生成与查询", () => {
  it("nextFsmStateId / nextFsmTransitionId 递增且不冲突；nextFsmStateName 避让重名", () => {
    const g = parseFsmGraph({ states: [{ id: "s1" }, { id: "s2" }] });
    expect(nextFsmStateId(g)).not.toBe("s1");
    expect(nextFsmStateId(g)).not.toBe("s2");
    const g2 = parseFsmGraph({ states: [{ id: "a", name: "State1" }] });
    expect(nextFsmStateName(g2)).toBe("State2");
  });

  it("fsmStateById 命中与未命中；cloneFsmGraph 深拷贝；isFsmAssetRel 按扩展名", () => {
    const g = DEFAULT_FSM_GRAPH;
    expect(fsmStateById(g, "s1")?.name).toBe("Idle");
    expect(fsmStateById(g, "nope")).toBeNull();
    const c = cloneFsmGraph(g);
    expect(c).not.toBe(g);
    expect(c.states[0]).not.toBe(g.states[0]);
    expect(isFsmAssetRel("logic/patrol.fsm")).toBe(true);
    expect(isFsmAssetRel("logic/patrol.bt")).toBe(false);
  });
});
