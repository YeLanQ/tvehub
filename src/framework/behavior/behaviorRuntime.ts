// ---------------------------------------------------------------------------
// 行为树求值引擎（framework 层，纯 TS 无渲染依赖）：编辑器与播放端共用。
//
// BTRunner 以递归下降求值整棵树，返回三值状态（success/failure/running）。
// 运行记忆（选择/顺序的 running 子节点游标、wait/timeout 的累计时长、
// repeat/retry 的剩余次数）按节点 id 存表；节点完成或被子树重启时清理，
// 保证 running 中断恢复语义（同一帧序内继续上次的进度）。动作叶子经
// onAction 处理器上抛给嵌入方（编辑器预览 / 脚本 / 播放端）。
// ---------------------------------------------------------------------------

import type { BTNode, BTStatus } from "./behaviorTypes";

/** 动作处理器：返回三值状态（缺省视为 success）；node 为动作叶节点本体 */
export type BTActionHandler = (node: BTNode, runner: BTRunner) => BTStatus | void;

/** 布尔/数值黑板值（条件叶子的求值对象） */
export type BTBlackboardValue = number | boolean;

export class BTRunner {
  /** 树根（编辑器改树后可直接替换，替换后调用 reset 清运行记忆） */
  root: BTNode | null;
  /** 黑板（条件叶子读写；初始为空，由嵌入方注入初值） */
  blackboard: Record<string, BTBlackboardValue> = {};
  /** 动作叶子处理器（未设置时动作叶子直接成功） */
  onAction: BTActionHandler | null = null;

  /** 选择/顺序节点：running 子节点游标 */
  private runIndex = new Map<string, number>();
  /** wait/timeout 节点：已累计秒数 */
  private elapsed = new Map<string, number>();
  /** repeat/retry 节点：已完成的子轮次数 */
  private rounds = new Map<string, number>();

  constructor(root: BTNode | null = null) {
    this.root = root;
  }

  /** 清空全部运行记忆（树的更改 / 重新开始时调用） */
  reset(): void {
    this.runIndex.clear();
    this.elapsed.clear();
    this.rounds.clear();
  }

  /** 推进一棵树（dt 秒）；空树返回 failure */
  tick(dt: number): BTStatus {
    if (!this.root) return "failure";
    return this.run(this.root, dt);
  }

  // —— 组合节点 ——

  private runSelector(node: BTNode, dt: number): BTStatus {
    // running 记忆：从上次运行的子节点继续（其前的子节点本轮跳过）
    let i = this.runIndex.get(node.id) ?? 0;
    if (i === 0) this.touch(node);
    for (; i < node.children.length; i++) {
      const st = this.run(node.children[i], dt);
      if (st === "running") {
        this.runIndex.set(node.id, i);
        return "running";
      }
      if (st === "success") {
        this.complete(node);
        return "success";
      }
    }
    this.complete(node);
    return "failure";
  }

  private runSequence(node: BTNode, dt: number): BTStatus {
    let i = this.runIndex.get(node.id) ?? 0;
    if (i === 0) this.touch(node);
    for (; i < node.children.length; i++) {
      const st = this.run(node.children[i], dt);
      if (st === "running") {
        this.runIndex.set(node.id, i);
        return "running";
      }
      if (st === "failure") {
        this.complete(node);
        return "failure";
      }
    }
    this.complete(node);
    return "success";
  }

  private runParallel(node: BTNode, dt: number): BTStatus {
    this.touch(node);
    let allSuccess = true;
    for (const c of node.children) {
      const st = this.run(c, dt);
      if (st === "failure") {
        this.complete(node);
        return "failure";
      }
      if (st !== "success") allSuccess = false;
    }
    // 仍有子节点在运行：保留其 running 记忆（累计时长/游标），只在本节点完成时清理
    if (!allSuccess) return "running";
    this.complete(node);
    return "success";
  }

  // —— 装饰节点 ——

  private runInvert(node: BTNode, dt: number): BTStatus {
    const child = node.children[0];
    if (!child) return "failure";
    const st = this.run(child, dt);
    if (st === "running") return "running";
    return st === "success" ? "failure" : "success";
  }

  private runSucceeder(node: BTNode, dt: number): BTStatus {
    const child = node.children[0];
    if (!child) return "success";
    const st = this.run(child, dt);
    return st === "running" ? "running" : "success";
  }

  private runRepeat(node: BTNode, dt: number): BTStatus {
    const child = node.children[0];
    if (!child) return "success";
    const infinite = (node.count ?? 0) <= 0;
    for (;;) {
      const st = this.run(child, dt);
      if (st === "running") return "running";
      if (st === "failure") {
        this.rounds.delete(node.id);
        return "failure";
      }
      if (infinite) {
        // 无限重复：重置子树后继续（单帧最多一轮，防饿死帧循环）
        this.resetSubtree(child);
        return "running";
      }
      const done = (this.rounds.get(node.id) ?? 0) + 1;
      this.rounds.set(node.id, done);
      this.resetSubtree(child);
      if (done >= (node.count ?? 1)) {
        this.rounds.delete(node.id);
        return "success";
      }
      return "running";
    }
  }

  private runRetry(node: BTNode, dt: number): BTStatus {
    const child = node.children[0];
    if (!child) return "failure";
    const infinite = (node.count ?? 0) <= 0;
    for (;;) {
      const st = this.run(child, dt);
      if (st === "running") return "running";
      if (st === "success") {
        this.rounds.delete(node.id);
        return "success";
      }
      if (infinite) {
        this.resetSubtree(child);
        return "running";
      }
      const done = (this.rounds.get(node.id) ?? 0) + 1;
      this.rounds.set(node.id, done);
      this.resetSubtree(child);
      if (done >= (node.count ?? 1)) {
        this.rounds.delete(node.id);
        return "failure";
      }
      return "running";
    }
  }

  private runTimeout(node: BTNode, dt: number): BTStatus {
    const child = node.children[0];
    if (!child) return "failure";
    const t = (this.elapsed.get(node.id) ?? 0) + dt;
    const st = this.run(child, dt);
    if (st === "running") {
      if (t >= (node.seconds ?? 0)) {
        this.complete(node);
        return "failure";
      }
      this.elapsed.set(node.id, t);
      return "running";
    }
    this.complete(node);
    return st;
  }

  // —— 叶子节点 ——

  private runWait(node: BTNode, dt: number): BTStatus {
    const t = (this.elapsed.get(node.id) ?? 0) + dt;
    if (t >= (node.seconds ?? 0)) {
      this.elapsed.delete(node.id);
      return "success";
    }
    this.elapsed.set(node.id, t);
    return "running";
  }

  private runCondition(node: BTNode): BTStatus {
    const v = this.blackboard[node.param ?? ""];
    if (v === undefined) return "failure";
    const n = typeof v === "boolean" ? (v ? 1 : 0) : v;
    const target = node.value ?? 0;
    switch (node.op ?? ">=") {
      case ">":
        return n > target ? "success" : "failure";
      case "<":
        return n < target ? "success" : "failure";
      case ">=":
        return n >= target ? "success" : "failure";
      case "<=":
        return n <= target ? "success" : "failure";
      case "==":
        return n === target ? "success" : "failure";
      case "!=":
        return n !== target ? "success" : "failure";
    }
  }

  private runAction(node: BTNode): BTStatus {
    const st = this.onAction?.(node, this);
    return st ?? "success";
  }

  // —— 分发与运行记忆 ——

  private run(node: BTNode, dt: number): BTStatus {
    switch (node.type) {
      case "selector":
        return this.runSelector(node, dt);
      case "sequence":
        return this.runSequence(node, dt);
      case "parallel":
        return this.runParallel(node, dt);
      case "invert":
        return this.runInvert(node, dt);
      case "succeeder":
        return this.runSucceeder(node, dt);
      case "repeat":
        return this.runRepeat(node, dt);
      case "retry":
        return this.runRetry(node, dt);
      case "timeout":
        return this.runTimeout(node, dt);
      case "wait":
        return this.runWait(node, dt);
      case "condition":
        return this.runCondition(node);
      case "action":
        return this.runAction(node);
      default:
        return "failure";
    }
  }

  /** 节点开始新一轮求值（此前先清它残留的记忆） */
  private touch(node: BTNode): void {
    this.runIndex.delete(node.id);
    this.elapsed.delete(node.id);
    this.rounds.delete(node.id);
  }

  /** 节点完成：清记忆并递归清子树（下一轮从头开始） */
  private complete(node: BTNode): void {
    this.resetSubtree(node);
  }

  /** 重置子树的全部运行记忆（repeat/retry 重启子节点用） */
  private resetSubtree(node: BTNode): void {
    const walk = (n: BTNode): void => {
      this.runIndex.delete(n.id);
      this.elapsed.delete(n.id);
      this.rounds.delete(n.id);
      for (const c of n.children) walk(c);
    };
    walk(node);
  }
}
