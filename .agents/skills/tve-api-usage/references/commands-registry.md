# 单元：命令注册表（`src/app/commands/`）

## 契约

命令 = 一次可被多入口（工具栏/快捷键/右键/拖放/devtools·MCP）复用的用户意图。

`EditorCommand<A>`（types.ts:18）：`{ id, label, group, expose?, description?,
canRun?(ctx), run(ctx, args) }`；`CommandContext { view: "home"|"editor", hasProject }`；
`CommandResult = { ok:true, value? } | { ok:false, skipped?, error? }`。

registry.ts 六函数：

| 函数 | 语义 |
|---|---|
| `registerCommand(cmd)` | 全局唯一注册；重复 id 记 warning 并覆盖（热替换友好） |
| `getCommand(id)` / `hasCommand(id)` | 查定义 / 查存在 |
| `listCommands()` | 全部命令（注册顺序；驱动工具权限与 MCP 清单） |
| `dispatchCommand(id, args?, opts?)` → `CommandResult` | **统一入口，不抛错**：未知命令→error；canRun false→skipped；run 抛错→error（默认写 logStore，`opts.logError:false` 静默） |
| `runCommand(id, args?, opts?)` | 异常语义适配层：成功返回 run 值；失败抛 Error；skipped 视为成功返回 undefined |

**自注册**：`import "./app/commands"`（index.ts）即全量注册四个命令文件
（editorCommands / nodeCommands / assetCommands / remoteCommands）；两个窗口入口
（main.ts / home-main.ts）都导入，保证 dispatch 前注册表就绪。

## 使用例

注册（`src/app/commands/editorCommands.ts:17`，完整小命令范本）：

```ts
registerCommand({
  id: "editor.undo",
  label: "撤销",
  group: "编辑器",
  canRun: (ctx) => ctx.view === "editor" && !isEditingText(),
  run: () => {
    const store = getEditorStore();
    if (store.state.mounted) store.engine.undo();
  },
});
```

派发：`src/App.vue:106` 全局快捷键 `dispatchCommand("editor.gizmoMode", { mode })`；
`src/app/components/HierarchyPanel.vue:332` 右键/按钮 `dispatchCommand("node.add", args)`；
`src/app/components/Viewport.vue:124` 视口拖放落位。

devtools/MCP 适配（`src/app/lib/devtools/handlers.ts:60`）用 runCommand 把 error 回客户端：

```ts
runCommand(cmdId, normalizeParams(...), { logError: false });
```

## 测试例

当前无 spec。registry 本身可无依赖直测（推荐写法，
`src/app/commands/registry.spec.ts`）：

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { registerCommand, getCommand, dispatchCommand, runCommand } from "./registry";

const echo = { id: "test.echo", label: "回声", group: "测试",
  run: (_ctx, args: any) => args };

describe("命令注册表", () => {
  beforeEach(() => registerCommand(echo));

  it("正常：dispatch 返回 run 值", async () => {
    const r = await dispatchCommand("test.echo", { n: 1 });
    expect(r).toEqual({ ok: true, value: { n: 1 } });
  });
  it("异常：未知命令/执行抛错 → 结构化 error 不抛出", async () => {
    expect((await dispatchCommand("nope")).ok).toBe(false);
    registerCommand({ ...echo, id: "test.boom", run: () => { throw new Error("boom"); } });
    expect((await dispatchCommand("test.boom", undefined, { logError: false })).error).toBe("boom");
  });
  it("空值：canRun 不满足 → skipped；runCommand 对 skipped 返回 undefined", async () => {
    registerCommand({ id: "test.skip", label: "s", group: "g", canRun: () => false, run: () => 1 });
    expect((await dispatchCommand("test.skip")).skipped).toBe(true);
    await expect(runCommand("test.skip")).resolves.toBeUndefined();
  });
});
```

注意：dispatch 内部构造 CommandContext 会拉起 project store（jsdom 下可加载、不触 IPC）。
