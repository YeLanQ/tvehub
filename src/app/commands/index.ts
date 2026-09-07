// 命令层公共出口：导入本模块即全量注册命令（各命令文件在模块加载时自注册）。
// 两个窗口入口（main.ts / home-main.ts）都导入，保证 dispatch 前注册表就绪。
//
// 使用：
//   import { dispatchCommand } from "./commands";
//   void dispatchCommand("node.delete", { ids });          // 结构化结果、不抛错
//   const value = await runCommand("node.add", {...});     // 异常语义（devtools/组件 await）

import "./editorCommands";
import "./nodeCommands";
import "./remoteCommands";

export {
  registerCommand,
  getCommand,
  hasCommand,
  listCommands,
  dispatchCommand,
  runCommand,
} from "./registry";
export type { CommandContext, CommandResult, EditorCommand } from "./types";
