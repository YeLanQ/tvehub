# 单元：助手大脑域 IPC（`src/lib/api.ts` brain 段 + Rust `src-tauri/src/brain/`）

## 契约

冷热数据中心 + 神经知识网络图谱（因果链进化、向量自压缩）+ 策略门控引擎，
Rust 侧总装在 `src-tauri/src/brain/mod.rs`（Brain 状态，setup 阶段以
`<config_root>/brain/snapshot.json.gz` 为持久化路径挂载）。

| 方法（后端命令） | 用途 |
|---|---|
| `brainQuery(text, topK?)` → BrainRouteHit[] | 语义检索：任务文本 → 技能/命令/概念节点（余弦种子 + 一跳邻接加成，类型先验技能 > 命令 > 概念） |
| `brainPlan(task)` → BrainPlan | 策略规划：主技能 + 推荐 steps（区域/效能比）+ 决策 `autoExecute / needConfirm / deny`；决策规则 = 任一步黄灯需确认、红灯拒绝、全绿且瓶颈效能比 ≥ 0.99 才可自主执行 |
| `brainExecute({ task, method, params? })` → BrainExecOutcome | **决策中心执行（助手编辑器工具统一入口）**：门控（zones 三区 + 任务审批会话 + 效能比）→ devtools 命令模式派发（`internal_call_blocking`：权限门控 → Rust 直答 → 中控转发编辑器执行器）→ 观测回写闭环。status：`ok`（result 在 `result`，工具失败以 `result.error` 表达）/ `needConfirm`（黄灯未批准，未执行，批准后重发）/ `denied` |
| `brainApprove(task)` → void | 登记任务审批会话：用户批准后调用，该任务的黄灯调用在有效期内（10 分钟）直接放行；tick 清理过期项 |
| `brainObserve({ task, method, ok, ms })` → BrainObserveReport | 观测回写：记账台账 + 因果链进化（task→cmd→outcome 边强化，半衰期衰减）；每 25 次自动 tick（衰减修剪 → 向量近重复合并 → 情景冷却下沉 → 快照落盘）。**brain_execute 已内置观测闭环，前端不再手动上报——此命令保留供旁路观测** |
| `brainStats()` → BrainStatsReport | 状态报表：节点分布/冷层条数/向量压缩字节数/各方法正确率与平均耗时/决策计数 |

领域分层：`brain/store/`（hot 内存 + cold gzip 归档，温度 = 频次 + 新近度半衰期）、
`brain/graph/`（图操作/因果链/语义路由）、`brain/vector/`（128 维哈希嵌入 → i8 量化，
近重复 cos ≥ 0.999 合并）、`brain/policy/`（zones 三区表 / budget 效能比 /
strategy 计划）、`brain/skillsrc/`（摄取构建期内嵌技能索引）、`brain/execute.rs`
（**决策中心执行器**：`Brain::execute` 三段式持锁——门控（锁）→ 派发（无锁，
可等编辑器回填 60s）→ 观测（锁）；审批会话存 `BrainCore.approvals`）。

## 使用例

`src/assistant-window/brain.ts:39`（execBrainTool：brain.* 决策咨询直连，不经执行派发）：

```ts
if (name === "brain.plan") {
  return await api.brainPlan(String(params.task ?? fallbackTask ?? ""));
}
```

`src/assistant-window/tools.ts`（编辑器工具统一经决策中心：needConfirm 时经
注入的确认回调请求用户批准 → `brainApprove` 登记会话 → 重发；成败均以
`{ error }` 结构回喂模型自纠；观测由后端在执行闭环内回写）：

```ts
let out = await api.brainExecute({ task, method: name, params });
if (out.status === "needConfirm" && requestConfirm) {
  const approved = await requestConfirm({ method: name, reason: out.reason });
  if (!approved) return { error: `用户拒绝执行「${name}」…` };
  await api.brainApprove(task);
  out = await api.brainExecute({ task, method: name, params });
}
return outcomeToToolResult(out, name);
```

`src/assistant-window/agent.ts:73`（系统提示词的策略门：autoExecute 自主执行 /
needConfirm 先向用户确认 / deny 拒绝并转述原因；模型不支持 function-calling 时
以正文 JSON 兜底调用）。

技能进构建链路：`src-tauri/build.rs` 调 `build_skills.rs::emit_skills_index`，
扫描 `.agents/skills/*/SKILL.md` frontmatter 生成 `OUT_DIR/skills_index.json`，
`brain/skillsrc/mod.rs` `include_str!` 内嵌；改技能文档会触发 rerun-if-changed 重编。

## 测试例

Rust 侧单测随模块内联（`cargo test --lib`，brain 域含执行域）：

- `src-tauri/src/brain/execute.rs` — 门控三区（绿灯放行/黄灯未批需确认/获批放行/
  红灯拒绝）、审批会话覆盖与过期、全方法门控与区域一致性
- `src-tauri/src/brain/tests.rs` — 端到端：内嵌技能启动/因果链进化/连续失败跌破
  0.99 门控/tick 快照往返/自动 tick 间隔
- `brain/policy/budget.rs` — 效能比边界（冷启动过门、20 错 1 降级、慢调用降速、
  门槛 0.99 含边界）
- `brain/graph/route.rs` — 语义路由命中/无关查询低分/访问加热
- `brain/store/` — 冷却下沉/结构类拒绝下沉/按 id 提升/gzip 归档往返

前端 `src/assistant-window/tools.spec.ts` 覆盖 root 注入与决策中心回执 → 工具结果
转换（ok 透传/denied/needConfirm/缺 result 四态）；`agent.spec.ts` 覆盖提示词策略
门注入。真机验证项：助手会话发起写操作观察确认浮动条与批准后放行（brain.stats
对照 need_confirm/auto_execute 计数）。
