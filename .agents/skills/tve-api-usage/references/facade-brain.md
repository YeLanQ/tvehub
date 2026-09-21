# 单元：助手大脑域 IPC（`src/lib/api.ts` brain 段 + Rust `src-tauri/src/brain/`）

## 契约

冷热数据中心 + 神经知识网络图谱（因果链进化、向量自压缩）+ 策略门控引擎，
Rust 侧总装在 `src-tauri/src/brain/mod.rs`（Brain 状态，setup 阶段以
`<config_root>/brain/snapshot.json.gz` 为持久化路径挂载）。

| 方法（后端命令） | 用途 |
|---|---|
| `brainQuery(text, topK?)` → BrainRouteHit[] | 语义检索：任务文本 → 技能/命令/概念节点（余弦种子 + 一跳邻接加成，类型先验技能 > 命令 > 概念） |
| `brainPlan(task)` → BrainPlan | 策略规划：主技能 + 推荐 steps（区域/效能比）+ 决策 `autoExecute / needConfirm / deny`；决策规则 = 任一步黄灯需确认、红灯拒绝、全绿且瓶颈效能比 ≥ 0.99 才可自主执行 |
| `brainObserve({ task, method, ok, ms })` → BrainObserveReport | 观测回写：记账台账 + 因果链进化（task→cmd→outcome 边强化，半衰期衰减）；每 25 次自动 tick（衰减修剪 → 向量近重复合并 → 情景冷却下沉 → 快照落盘） |
| `brainStats()` → BrainStatsReport | 状态报表：节点分布/冷层条数/向量压缩字节数/各方法正确率与平均耗时/决策计数 |

领域分层：`brain/store/`（hot 内存 + cold gzip 归档，温度 = 频次 + 新近度半衰期）、
`brain/graph/`（图操作/因果链/语义路由）、`brain/vector/`（128 维哈希嵌入 → i8 量化，
近重复 cos ≥ 0.999 合并）、`brain/policy/`（zones 三区表 / budget 效能比 /
strategy 计划）、`brain/skillsrc/`（摄取构建期内嵌技能索引）。

## 使用例

`src/assistant-window/brain.ts:45`（execBrainTool：brain.* 直连不走 devtools 桥）：

```ts
if (name === "brain.plan") {
  return await api.brainPlan(String(params.task ?? fallbackTask ?? ""));
}
```

`src/assistant-window/tools.ts:126`（工具执行器分流：brain.* → execBrainTool，
编辑器方法执行后经 brain.ts:62 observeExecution 异步观测上报，成败按 `{ error }` 判定）：

```ts
if (name.startsWith("brain.")) {
  return await execBrainTool(name, params, task);
}
```

`src/assistant-window/agent.ts:149`（系统提示词的策略门：autoExecute 自主执行 /
needConfirm 先向用户确认 / deny 拒绝并转述原因）。

技能进构建链路：`src-tauri/build.rs` 调 `build_skills.rs::emit_skills_index`，
扫描 `.agents/skills/*/SKILL.md` frontmatter 生成 `OUT_DIR/skills_index.json`，
`brain/skillsrc/mod.rs` `include_str!` 内嵌；改技能文档会触发 rerun-if-changed 重编。

## 测试例

Rust 侧单测随模块内联（`cargo test --lib` 共 155 例，brain 域 55 例）：

- `src-tauri/src/brain/tests.rs` — 端到端：内嵌技能启动/因果链进化/连续失败跌破
  0.99 门控/tick 快照往返/自动 tick 间隔
- `brain/policy/budget.rs` — 效能比边界（冷启动过门、20 错 1 降级、慢调用降速、
  门槛 0.99 含边界）
- `brain/graph/route.rs` — 语义路由命中/无关查询低分/访问加热
- `brain/store/` — 冷却下沉/结构类拒绝下沉/按 id 提升/gzip 归档往返

前端 `src/assistant-window/agent.spec.ts` 覆盖提示词策略门注入；brain.* 分支为薄
IPC 封装不直测（口径同 facade-ai）。真机验证项：助手会话里调 brain.plan 观察
三态决策与 devtools 工具的效能比演化（`brain.stats` 对照）。
