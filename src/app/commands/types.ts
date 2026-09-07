// 命令层类型：命令 = 一次可被多个入口（工具栏/快捷键/右键/拖放/Home/devtools·MCP）
// 复用的用户意图。命令对象只做编排；场景写/撤销仍由 engine（后端权威）执行。

/** 命令执行上下文（dispatch 时构造） */
export interface CommandContext {
  /** 当前 project view（"editor" | "home"；Tauri 双窗口各自持有 store） */
  view: "home" | "editor";
  /** 是否已打开项目 */
  hasProject: boolean;
}

/** 命令执行结果（结构化；dispatch 不抛错，需异常语义用 runCommand） */
export type CommandResult =
  | { ok: true; value?: unknown }
  | { ok: false; skipped?: boolean; error?: string };

/** 一条命令：全局唯一 id + 展示信息 + 可用性 + 执行主体 */
export interface EditorCommand<A = unknown> {
  id: string;
  /** 展示名（工具栏/菜单/工具权限清单） */
  label: string;
  /** 分组名（工具权限按此分组：编辑器/场景/节点/状态/预览/资源…） */
  group: string;
  /** 远程（devtools/MCP）暴露时的描述与入口开关 */
  expose?: boolean;
  description?: string;
  /** 可用性判定（如焦点在文本框、窗口非编辑器视图时返回 false → 静默跳过） */
  canRun?: (ctx: CommandContext) => boolean;
  /** 执行主体；args 为各入口传入的结构化参数（可为 undefined） */
  run: (ctx: CommandContext, args: A) => unknown | Promise<unknown>;
}
