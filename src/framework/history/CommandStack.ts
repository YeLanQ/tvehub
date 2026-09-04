import { EventBus } from "../../platform_abstraction/eventBus";

export interface HistoryEvents {
  changed: { canUndo: boolean; canRedo: boolean; depth: number };
}

interface UndoableCommand {
  readonly label: string;
  mergeKey?: string;
  execute(): void;
  undo(): void;
}

/**
 * 命令栈（栈模式）。
 * undoStack + redoStack 两个数组即双栈：
 *  - execute 新命令 → 压 undoStack 顶，清 redoStack。
 *  - undo → 弹 undoStack 顶执行 undo()，压 redoStack。
 *  - redo → 对称。
 * 支持带 mergeKey 的连续同类命令合并（例如拖拽中的 Transform）。
 */
export class CommandStack {
  private undoStack: UndoableCommand[] = [];
  private redoStack: UndoableCommand[] = [];
  readonly events = new EventBus<HistoryEvents>();

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get depth(): number {
    return this.undoStack.length;
  }

  execute(cmd: UndoableCommand, mergeKey?: string): void {
    cmd.execute();
    this.recordOnly(cmd, mergeKey);
    this.redoStack.length = 0;
    this.notify();
  }

  /**
   * 登记一个"已就地生效"的命令（例如 gizmo 期间已即时改好场景）。
   * 传入同一对象并在拖动中持续更新，可天然实现 before/after 合并。
   */
  recordOnly(cmd: UndoableCommand, mergeKey?: string): void {
    if (mergeKey) cmd.mergeKey = mergeKey;
    const top = this.undoStack[this.undoStack.length - 1];
    if (mergeKey && top && top.mergeKey === mergeKey) {
      this.undoStack[this.undoStack.length - 1] = cmd;
    } else {
      this.undoStack.push(cmd);
    }
    this.redoStack.length = 0;
    this.notify();
  }

  undo(): UndoableCommand | undefined {
    const cmd = this.undoStack.pop();
    if (!cmd) return undefined;
    cmd.undo();
    this.redoStack.push(cmd);
    this.notify();
    return cmd;
  }

  redo(): UndoableCommand | undefined {
    const cmd = this.redoStack.pop();
    if (!cmd) return undefined;
    cmd.execute();
    this.undoStack.push(cmd);
    this.notify();
    return cmd;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.notify();
  }

  peekUndoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }

  peekRedoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }

  listLabels(): string[] {
    return this.undoStack.map((c) => c.label);
  }

  private notify(): void {
    this.events.emit("changed", {
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      depth: this.depth,
    });
  }
}
