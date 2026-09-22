# 单元：助手域 IPC（`src/lib/api.ts` 助手段）

## 契约

| 方法（后端命令） | 用途 |
|---|---|
| `aiChatStream(args)` → 立即返回 | 发起流式对话（OpenAI 兼容）：args `{ reqId, baseUrl, apiKey, model, messages, temperature? }`；增量/结束/错误经事件 `ai:chunk`（`{reqId, delta}` 或 `{reqId, toolCalls[]}`）/ `ai:done`（`{reqId, cancelled?}`）/ `ai:error`（`{reqId, message}`）回推 |
| `aiCancel(reqId)` | 取消进行中的流（幂等；分块边界生效） |
| `aiListModels(baseUrl, apiKey)` → string[] | 拉取模型清单（GET /models；不支持时前端手填兜底） |
| `toggleAssistantWindow()` → boolean | 开/关助手浮动面板（全局单例窗口 label `assistant`；返回切换后是否可见） |
| `devtoolsCall(method, params?)` → unknown | **进程内执行一条 devtools 方法**（权限门控 → Rust 直答 `project.list/project.create/scene.list/asset.list/asset.read/asset.write/scene.tree/scene.save/file.index/file.search` → 其余转发编辑器执行器回填；60s 超时）。**助手工作区语义**：`scene.list/asset.list/asset.read/asset.write/file.index/file.search` 支持显式 `root` 参数指定项目目录（不依赖编辑器会话），缺省回退活跃编辑器会话。**助手 LLM 工具调用不走此门面**——统一经 `brainExecute`（决策中心门控后内部同样走这条通道）；此门面供窗口 UI 直调（如助手文件树） |
| `assistantConvIndexGet/Set`、`assistantConvDocGet/Set/Delete(id)` | **助手会话独立存储**（`配置根/assistant/conversations/`：`index.json` + `conv-<id>.json`，原子写，id 白名单 `[A-Za-z0-9_-]`）。与 ui-state 分离——会话是数据不是界面状态；历史 `tve:ai:conv-*` 键由后端 setup 一次性迁移（幂等）。消费方 `conversations.ts`：所有写路径先等索引加载完成（未加载绝不回写，防内存空副本覆盖磁盘索引），消息 append 即时落盘（无防抖） |

实现：Rust `src-tauri/src/ai.rs`（SSE 解析 + 事件回推）与 `devtools.rs` 的
`devtools_internal_call`（整体在 `spawn_blocking` 执行——本地直答会 block_on 异步锁，
不能落在 tokio 运行时线程；internal_pending 直达 `devtools_reply`，与控制服务器
启停无关）。`project.create` 已下沉为 Rust 直答（`project/create_local.rs`：exe 旁
/仓库 public/templates 读内置 3D 模板 → 脚手架 + 登记最近 + 广播），不依赖编辑器；
未传 parent 时取 prefs 默认项目目录，无默认则报错要求显式提供（后端不弹目录框）。

## 使用例

`src/assistant-window/agent.ts:49`（createTauriTransport：listen 三事件 + 调用）：

```ts
await api.aiChatStream({ reqId, baseUrl: args.baseUrl, apiKey: args.apiKey, model: args.model,
  messages: args.messages, temperature: args.temperature });
```

`src/assistant-window/AssistantApp.vue`（窗口 UI 直调 devtools 桥——文件树列资产）：

```ts
const list = await api.devtoolsCall("asset.list", { root: p.path });
```

## 测试例

当前无 spec（薄 IPC + Rust 侧 HTTP）。前端可测面已覆盖：

- `src/assistant-window/agent.spec.ts` — 工具循环/错误回喂/轮上限/提示词组装（注入 chat 桩）
- `src/assistant-window/tools.spec.ts` — 工作区 root 注入/决策中心回执转换（ok/denied/needConfirm/缺 result）
- `src/assistant-window/conversations.spec.ts` — 按项目隔离/新建/删除回退
- `src/assistant-window/store.spec.ts` — 卡片与供应商 CRUD/保底
- `src/assistant-window/skills/skills.spec.ts` — 技能注册/路由

真机验证项：真实端点的流式输出、取消、/models 拉取（无 key 无法自动化）。
