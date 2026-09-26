import { describe, expect, it } from "vitest";
import { SceneClient, type SceneChangedEvent, type SceneTransport, type TransformSnapshot } from "./SceneClient";
import { Node } from "../prototype/Node";
import { createDefaultRegistry } from "../prototype/PrototypeRegistry";
import { NodeFactory } from "../factory/NodeFactory";
import type { JsonRecord } from "../prototype/types";

// 属性面板快速连续编辑的提交竞态：后端回显（整节点快照）滞后于本地乐观编辑时，
// 无条件回填会把新编辑打回（视觉回弹/反复跳），且后续编辑从被打回的状态捕获
// before/after 会永久丢数据。修复 = 提交串行链 + 在途回显抑制。

/** 受控假 transport：patchNode 挂起（手动放行），记录调用顺序 */
function makeTransport() {
  const calls: string[] = [];
  const gates: (() => void)[] = [];
  const transport: SceneTransport = {
    addNode: async () => undefined,
    addTree: async () => undefined,
    removeNodes: async () => undefined,
    reparentNodes: async () => undefined,
    rename: async () => undefined,
    setTransform: async () => undefined,
    patchNodes: async () => undefined,
    undo: async () => ({ canUndo: false, canRedo: false, depth: 0, undoLabel: null, redoLabel: null, labels: [] }),
    redo: async () => ({ canUndo: false, canRedo: false, depth: 0, undoLabel: null, redoLabel: null, labels: [] }),
    patchNode: () =>
      new Promise<void>((resolve) => {
        calls.push("patchNode");
        gates.push(() => resolve());
      }),
  };
  return { transport, calls, releaseAll: () => { while (gates.length) gates.shift()!(); } };
}

function makeClient(transport: SceneTransport): SceneClient {
  const client = new SceneClient(new NodeFactory(createDefaultRegistry()));
  client.setTransport(transport);
  return client;
}

function addNode(client: SceneClient, name: string, x: number): Node {
  const n = new Node({ name });
  (n as unknown as { transform: { position: { x: number } } }).transform.position.x = x;
  client.add(n);
  return n;
}

const xOf = (n: Node): number => (n.toJSON() as { transform: { position: { x: number } } }).transform.position.x;

/** 模拟后端回显事件（携带整节点快照，position.x = 指定值） */
function echo(client: SceneClient, node: Node, x: number, kind: SceneChangedEvent["kind"] = "properties"): void {
  const snap = node.toJSON() as JsonRecord;
  (snap as { transform?: { position: { x: number } } }).transform = { position: { x } } as never;
  client.applyEvent({
    root: null, rel: "", kind, nodeId: node.id, revision: 1,
    nodes: [snap],
    history: { canUndo: false, canRedo: false, depth: 0, undoLabel: null, redoLabel: null, labels: [] },
    dirty: true,
  });
}

describe("属性提交竞态（回显抑制 + 串行链）", () => {
  it("在途回显不覆盖更新的本地编辑：连改两次，第一次的滞后回显不回弹", async () => {
    const { transport, releaseAll } = makeTransport();
    const client = makeClient(transport);
    const n = addNode(client, "A", 0);
    // 快速连改两次（两次提交都在途；乐观应用后 x=2）
    client.commitPatch(n.id, {} as JsonRecord, n.toJSON() as JsonRecord, "e1");
    (n as unknown as { transform: { position: { x: number } } }).transform.position.x = 2;
    client.commitPatch(n.id, {} as JsonRecord, n.toJSON() as JsonRecord, "e2");
    expect(xOf(n)).toBe(2);
    // 第一次提交的滞后回显（x=1）到达 → 不得回弹
    echo(client, n, 1);
    expect(xOf(n)).toBe(2);
    // 提交全部落定后再来的回显 = 最终状态 → 幂等无害
    releaseAll();
    await Promise.resolve();
    await Promise.resolve();
    echo(client, n, 2);
    expect(xOf(n)).toBe(2);
  });

  it("提交串行：两次 patchNode 按提交顺序出站（整节点快照乱序会互相覆盖）", async () => {
    const { transport, calls, releaseAll } = makeTransport();
    const client = makeClient(transport);
    const n = addNode(client, "B", 0);
    client.commitPatch(n.id, {} as JsonRecord, n.toJSON() as JsonRecord, "p1");
    client.commitPatch(n.id, {} as JsonRecord, n.toJSON() as JsonRecord, "p2");
    // 串行链按微任务逐环推进（resolve→链推进→下一环出站）：多轮 flush + 放行
    for (let i = 0; i < 5; i++) await Promise.resolve();
    releaseAll();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    releaseAll();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c === "patchNode").length).toBe(2);
  });

  it("在途窗口内的新编辑不被滞后回显吞掉", async () => {
    const { transport, releaseAll } = makeTransport();
    const client = makeClient(transport);
    const n = addNode(client, "C", 0);
    client.commitPatch(n.id, {} as JsonRecord, n.toJSON() as JsonRecord, "e1");
    const tx = n as unknown as { transform: { position: { x: number } } };
    tx.transform.position.x = 2;
    client.commitPatch(n.id, {} as JsonRecord, n.toJSON() as JsonRecord, "e2");
    tx.transform.position.x = 3;
    client.commitPatch(n.id, {} as JsonRecord, n.toJSON() as JsonRecord, "e3");
    echo(client, n, 1); // echo1 滞后到达
    echo(client, n, 2); // echo2 滞后到达
    expect(xOf(n)).toBe(3);
    releaseAll();
    await Promise.resolve();
    echo(client, n, 3); // 最终回显 = 提交 3 的状态
    expect(xOf(n)).toBe(3);
  });

  it("空值：transform 事件的滞后回显同样被抑制", async () => {
    const { transport, releaseAll } = makeTransport();
    const client = makeClient(transport);
    const n = addNode(client, "D", 0);
    const snap = (x: number): TransformSnapshot => ({
      position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
    });
    client.commitTransform(n.id, snap(0), snap(1));
    (n as unknown as { transform: { position: { x: number } } }).transform.position.x = 2;
    client.commitTransform(n.id, snap(1), snap(2));
    echo(client, n, 1, "transform"); // echo1 滞后 → 不回弹
    expect(xOf(n)).toBe(2);
    releaseAll();
    await Promise.resolve();
  });
});
