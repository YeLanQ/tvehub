import { describe, expect, it } from "vitest";
import { parseFsmGraph } from "./fsmTypes";
import { FsmRunner, type FsmRunnerHandlers } from "./fsmRuntime";

// 状态机求值引擎：启动/重置、三类触发器（事件/时长/条件）、链式过渡与回调时序。

interface Log {
  enters: string[];
  exits: string[];
  transitions: string[];
  handlers: FsmRunnerHandlers;
}

function recorder(): Log {
  const log: Log = { enters: [], exits: [], transitions: [], handlers: {} };
  log.handlers = {
    onEnter: (s) => log.enters.push(s.name),
    onExit: (s) => log.exits.push(s.name),
    onTransition: (from, to) => log.transitions.push(`${from.name}->${to.name}`),
  };
  return log;
}

/** 两状态图：Idle --(2s 时长且 hp<3)--> Run；Run --(事件 hit)--> Idle */
const graph = parseFsmGraph({
  entry: "s1",
  states: [
    { id: "s1", name: "Idle" },
    { id: "s2", name: "Run" },
  ],
  transitions: [
    { id: "t1", from: "s1", to: "s2", duration: 2, conditions: [{ param: "hp", op: "<", value: 3 }] },
    { id: "t2", from: "s2", to: "s1", event: "hit" },
  ],
  params: { hp: 10 },
});

describe("生命周期", () => {
  it("start 进入入口并上抛 onEnter；未启动 update 不动", () => {
    const log = recorder();
    const r = new FsmRunner(graph, log.handlers);
    expect(r.stateName).toBe("");
    expect(r.update(1)).toBe(false);
    r.start();
    expect(r.started).toBe(true);
    expect(r.stateName).toBe("Idle");
    expect(log.enters).toEqual(["Idle"]);
  });

  it("start 前黑板 = 图默认值拷贝（写参数不影响图）", () => {
    const r = new FsmRunner(graph);
    expect(r.getParam("hp")).toBe(10);
    r.setParam("hp", 1);
    expect(graph.params.hp).toBe(10);
  });

  it("reset 清运行态但保留黑板", () => {
    const r = new FsmRunner(graph);
    r.start();
    r.setParam("hp", 2);
    r.reset();
    expect(r.started).toBe(false);
    expect(r.stateName).toBe("");
    expect(r.stateTime).toBe(0);
    expect(r.getParam("hp")).toBe(2);
  });
});

describe("过渡触发器", () => {
  it("时长条件：停留不足不切，满足且参数成立才切", () => {
    const log = recorder();
    const r = new FsmRunner(graph, log.handlers);
    r.start();
    r.setParam("hp", 2);
    expect(r.update(1)).toBe(false);
    expect(r.stateName).toBe("Idle");
    expect(r.update(1)).toBe(true); // stateTime 累计到 2
    expect(r.stateName).toBe("Run");
    expect(r.stateTime).toBe(0); // 切换后清零
    expect(log.transitions).toEqual(["Idle->Run"]);
  });

  it("参数不满足（hp=10）即使时长达标也不切", () => {
    const r = new FsmRunner(graph);
    r.start();
    expect(r.update(5)).toBe(false);
    expect(r.stateName).toBe("Idle");
  });

  it("事件触发：进入状态后的首次发射有效，同状态重复发射去重", () => {
    const r = new FsmRunner(graph);
    r.start();
    r.setParam("hp", 2);
    r.update(5); // → Run
    r.fire("hit");
    r.fire("hit");
    expect(r.update(0.1)).toBe(true);
    expect(r.stateName).toBe("Idle");
    r.update(0.1); // 事件集合已随进入清空，不再回切
    expect(r.stateName).toBe("Idle");
  });

  it("fire 空串无副作用", () => {
    const r = new FsmRunner(graph);
    r.start();
    r.fire("");
    expect(r.update(1)).toBe(false);
  });
});

describe("链式过渡与强制切换", () => {
  it("同帧链式即时过渡（A→B→C），dt 只在首跳累计", () => {
    const chain = parseFsmGraph({
      entry: "a",
      states: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }],
      transitions: [
        { id: "t1", from: "a", to: "b" },
        { id: "t2", from: "b", to: "c" }, // 即时（duration=0）才能同帧链跳
      ],
    });
    const log = recorder();
    const r = new FsmRunner(chain, log.handlers);
    r.start();
    expect(r.update(1)).toBe(true);
    expect(r.stateName).toBe("C");
    expect(log.transitions).toEqual(["A->B", "B->C"]);
  });

  it("互切环在 16 跳内截断不死循环", () => {
    const loop = parseFsmGraph({
      entry: "a",
      states: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
      transitions: [
        { id: "t1", from: "a", to: "b" },
        { id: "t2", from: "b", to: "a" },
      ],
    });
    const r = new FsmRunner(loop);
    r.start();
    expect(r.update(0.016)).toBe(true); // 有过渡发生但必然终止
    expect(["A", "B"]).toContain(r.stateName);
  });

  it("forceState 未知 id 忽略；已知 id 强切并上抛 exit/enter", () => {
    const log = recorder();
    const r = new FsmRunner(graph, log.handlers);
    r.start();
    r.forceState("ghost");
    expect(r.stateName).toBe("Idle");
    r.forceState("s2");
    expect(r.stateName).toBe("Run");
    expect(log.exits).toEqual(["Idle"]);
    expect(log.enters).toEqual(["Idle", "Run"]);
  });
});

describe("异常输入", () => {
  it("entry 指向不存在状态（收敛层已回退，直接构造异常图时 start 空转）", () => {
    const broken = parseFsmGraph({ states: [{ id: "a", name: "A" }] });
    broken.entry = "ghost";
    const r = new FsmRunner(broken);
    r.start();
    expect(r.state).toBeNull();
    expect(r.update(1)).toBe(false);
  });

  it("update 负 dt / NaN 不产生过渡", () => {
    const r = new FsmRunner(graph);
    r.start();
    expect(r.update(-5)).toBe(false);
    expect(Number.isNaN(r.stateTime)).toBe(false);
  });
});
