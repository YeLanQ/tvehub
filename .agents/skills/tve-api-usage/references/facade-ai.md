# 单元：助手域 IPC（`src/lib/api.ts` 助手段）

## 契约

| 方法（后端命令） | 用途 |
|---|---|
| `aiChatStream(args)` → 立即返回 | 发起流式对话（OpenAI 兼容）：args `{ reqId, baseUrl, apiKey, model, messages, temperature? }`；增量/结束/错误经事件 `ai:chunk`（`{reqId, delta}` 或 `{reqId, toolCalls[]}`）/ `ai:done`（`{reqId, cancelled?}`）/ `ai:error`（`{reqId, message}`）回推 |
| `aiCancel(reqId)` | 取消进行中的流（幂等；分块边界生效） |
| `aiListModels(baseUrl, apiKey)` → string[] | 拉取模型清单（GET /models；不支持时前端手填兜底） |
| `toggleAssistantWindow()` → boolean | 开/关助手浮动面板（全局单例窗口 label `assistant`；返回切换后是否可见） |
| `devtoolsCall(method, params?)` → unknown | **进程内执行一条 devtools 方法**（权限门控 → Rust 直答 `project.list/scene.list/asset.list/asset.read/asset.write/scene.tree/scene.save` → 其余转发编辑器执行器回填；60s 超时）。**助手工作区语义**：`scene.list/asset.list/asset.read/asset.write` 支持显式 `root` 参数指定项目目录（不依赖编辑器会话），缺省回退活跃编辑器会话 |

实现：Rust `src-tauri/src/ai.rs`（SSE 解析 + 事件回推）与 `devtools.rs` 的
`devtools_internal_call`（整体在 `spawn_blocking` 执行——本地直答会 block_on 异步锁，
不能落在 tokio 运行时线程；internal_pending 直达 `devtools_reply`，与控制服务器
启停无关）。`project.create` 在前端完成（fetch 默认 3D 模板 → `api.createProject`
脚手架 + 登记最近），不依赖编辑器。

## 使用例

`src/assistant-window/agent.ts:49`（createTauriTransport：listen 三事件 + 调用）：

```ts
await api.aiChatStream({ reqId, baseUrl: args.baseUrl, apiKey: args.apiKey, model: args.model,
  messages: args.messages, temperature: args.temperature });
```

`src/assistant-window/tools.ts`（工具执行统一走 devtools 内部桥）：

```ts
const result = await api.devtoolsCall(name, params);
```

## 测试例

当前无 spec（薄 IPC + Rust 侧 HTTP）。前端可测面已覆盖：

- `src/assistant-window/agent.spec.ts` — 工具循环/错误回喂/轮上限/提示词组装（注入 chat 桩）
- `src/assistant-window/conversations.spec.ts` — 按项目隔离/新建/删除回退
- `src/assistant-window/store.spec.ts` — 卡片与供应商 CRUD/保底
- `src/assistant-window/skills/skills.spec.ts` — 技能注册/路由

真机验证项：真实端点的流式输出、取消、/models 拉取（无 key 无法自动化）。
