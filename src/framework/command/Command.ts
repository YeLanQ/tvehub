/**
 * 命令模式接口。
 * 每个可撤销操作封装为一个命令对象，携带 execute / undo。
 * redo 语义等价于重新 execute。
 */
export interface Command {
  readonly label: string;
  execute(): void;
  undo(): void;
}

/** 已就地生效、只需登记到栈的命令（如 gizmo 拖动结束）标记 */
export function isPresetApplied(cmd: Command): boolean {
  return (cmd as { _applied?: boolean })._applied === true;
}