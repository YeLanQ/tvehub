# 单元：助手大脑域 IPC（`src/lib/api.ts` brain 段 + Rust `src-tauri/src/brain/`）

## 契约

冷热数据中心 + 神经知识网络图谱（因果链进化、向量自压缩）+ 策略门控引擎，
Rust 侧总装在 `src-tauri/src/brain/mod.rs`（Brain 状态，setup 阶段以
`<config_root>/brain/snapshot.json.gz` 为持久化路径挂载）。

| 方法（后端命令） | 用途 |
|---|---|
| `brainQuery(text, topK?)` → BrainRouteHit[] | 语义检索：任务文本 → 技能/命令/概念节点（余弦种子 + 一跳邻接加成，类型先验技能 > 命令 > 概念） |
| `brainPlan(task)` → BrainPlan | 策略规划：主技能 + 推荐 steps（区域/效能比）+ 决策 `autoExecute / needConfirm / deny`；决策规则 = 任一步黄灯需确认、红灯拒绝、全绿且瓶颈效能比 ≥ 0.99 才可自主执行 |
| `brainDecompose(task, root?, spec?)` → BrainDecomposition | **语义单元化（自然语义处理层）**：任务文本 →（可选语言归一化 spec：助手 LLM 结构化的 taskType/task/keywords/files）→（分段：连接词/序号/标点）→（逐段神经图检索 + 命令预测：图命中优先、词典+动宾组合兜底）→ 有序单元任务（text/method 预测/zone/phase/refs 知识命中/exec/params）+ 处理轨迹 + 整任务 refs。**spec 存在时**：规范化表述作分段输入、keywords+文件基名只并入检索词料（不污染单元文本）、`analyze` 把默认 Act 判成 Inspect、`chat` 直通（零单元走直通路线）；**spec 缺失**（归一化不可用/超时）按原文走规则链路。**执行分层**：`exec: direct`（绿色通道）= 死板过程命令（editor.state/project.list/scene.list/asset.list 无参绿灯查询）——大脑直执行不经助手；`exec: assist` = 其余全部原子命令——**必须经助手**把自然语言转换为精准命令（大脑提取的建议参数随单元下发辅助）后交决策中心派发。模糊单元合并为**一次助手会话**按计划推进（避免逐单元独立会话的 N 倍上下文往返），纯直执行任务零 LLM 汇总完成 |
| `brainExecute({ task, method, params? })` → BrainExecOutcome | **决策中心执行（助手编辑器工具统一入口）**：门控（zones 三区 + 任务审批会话 + 效能比）→ devtools 命令模式派发（`internal_call_blocking`：权限门控 → Rust 直答 → 中控转发编辑器执行器）→ 观测回写闭环。status：`ok`（result 在 `result`，工具失败以 `result.error` 表达）/ `needConfirm`（黄灯未批准，未执行，批准后重发）/ `denied` |
| `brainApprove(task)` → void | 登记任务审批会话：用户批准后调用，该任务的黄灯调用在有效期内（10 分钟）直接放行；tick 清理过期项 |
| `brainObserve({ task, method, ok, ms })` → BrainObserveReport | 观测回写：记账台账 + 因果链进化（task→cmd→outcome 边强化，半衰期衰减）；每 25 次自动 tick（衰减修剪 → 向量近重复合并 → 情景冷却下沉 → 快照落盘）。**brain_execute 已内置观测闭环，前端不再手动上报——此命令保留供旁路观测** |
| `brainStats()` → BrainStatsReport | 状态报表：节点分布/冷层条数/向量压缩字节数/各方法正确率与平均耗时/决策计数 |
| `reposDocRead(id)` → RepoDoc \| null | **工坊资源全文（load_repo 直答）**：public/repos 文本资产运行时层，id 形如 `code/Rotator.ts`；只读无副作用不经决策中心，读前自动懒刷新对齐外部更新 |
| `reposDocList()` → RepoBrief[] | 工坊资源目录（id+title+summary，无正文）：load_repo 缺/错 id 时回喂，与 reposDocRead 同源同懒刷新 |
| `brainReposRefresh()` → ReposIngestReport | 手动刷新工坊资源层（跳过节流强制比对指纹）；一般无需调用——读路径（query/plan/decompose）自带 2s 节流懒刷新，外部 repos 增删改自动重对齐图谱，无需重新编译 |

领域分层：`brain/store/`（hot 内存 + cold gzip 归档，温度 = 频次 + 新近度半衰期）、
`brain/graph/`（图操作/因果链/语义路由）、`brain/vector/`（128 维哈希嵌入 → i8 量化，
近重复 cos ≥ 0.999 合并）、`brain/policy/`（zones 三区表 / budget 效能比 /
strategy 计划）、`brain/nlu/`（语义单元化：segment 分段 / matcher 命令预测 /
mod 总装 decompose）、`brain/skillsrc/`（摄取构建期内嵌技能索引）、`brain/docsrc/`
（**文档基图元**：public/docs submodule 的 22 篇手册经构建期 docs_index.json 内嵌，
摄取为 Concept 节点群——Mentions 词元锚点 + Uses 已知命令，与技能共同保证冷启动
检索底料非空）、`brain/reposrc/`（**工坊资源动态层**：public/repos 文本资产
（脚本原型/效果着色器等，复用 repos.rs 的 TEXT_EXTS/@desc 解析）运行时扫描入图，
节点 id `concept:repos:<分类>/<文件>` 与 docs 基图元同构（嵌入词料 =
标题+描述+路径+正文头部 260 字，受 upsert 400 字封顶）；指纹 = 路径+大小+mtime
折叠 FNV，读路径节流比对——外部 repos 更新自动摘除过期节点/重摄取变更，
**不重新编译**；`Brain::with_repos_root` 供测试注入临时仓库根）、`brain/fileidx/`
（**文件内模块索引**：@ 引用的大文本文件经决策中心
`file.index`/`file.search`（只读绿灯）建索引——split 三策略切分（md 标题/代码顶格
声明/定窗）→ 抽取式摘要 → 量化向量，gzip 落盘 `<brain目录>/fileidx.json.gz`，内容
哈希缓存失效自动重建、LRU 64 文件、单文件 ≤2MB、不存正文检索时重读切片；前端
`assistant-window/fileidx.ts` 判定 >12K 字符/截断/512KB 拒读转索引模式，只注入
摘要+模块目录，模型按需 file.search 取行号摘录）、`brain/execute.rs`
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

`src/assistant-window/nlu.ts`（单元计划纯逻辑：`usablePlan` 拆解质量守门、
`unitInstruction` 单元指令、`runUnitPlan` 逐单元小循环、`decomposeDigest`/
`parseStoredDecomposition` 落库往返）+ `src/assistant-window/NluSteps.vue`
（过程容器的大脑块：处理轨迹 + 单元任务行，运行实时 / 历史静态）+
`src/assistant-window/AssistantChat.vue` send()（先 `brainDecompose` 拆解上屏，
可用走 `runUnitPlan`，不可用回落整任务 `runAgent`）。

`src/assistant-window/nl-normalize.ts`（**语言归一化前置层**：自然语言 →
助手 LLM 单轮结构化 → `NormSpec{taskType, task, keywords, files}`——
operate 命令操作/create 指令创作/optimize 指令优化/analyze 指令解析/chat
闲聊；`parseNormalizedTask` 宽松提取 JSON，`filterExistingFiles` 只对
asset.list 清单做存在性校验（**不读文件内容**）；`normalizeNaturalLanguage`
独立传输实例 + 20s 超时 + aiCancel 收割孤儿流，任何失败返回 null 回落规则
链路；`AssistantChat.send()` 在大脑拆解前调用，spec 经 brainDecompose 下发）。

`src/assistant-window/loadable-index.ts`（**可加载资料索引**：docsList +
reposDocList 拉取两份目录（失败回落空），`loadableIndexPrompt` 渲染成系统
提示词的「可加载资料索引」段——弱模型不再空参试探 load_doc 换目录，首调
即中；`AssistantChat.send()` 每次 run 前取一次）。

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
- `brain/nlu/` — 分段（连接词/序号/标点/封顶去重）、命令预测（图命中优先/
  词典加权/动宾组合/阶段推断）、总装（多单元拆解/方法与区域/direct-assist
  分层与参数提取/空任务/闲聊无预测/语言归一化 spec：锚点检索/analyze→
  Inspect/chat 直通/轨迹标注）、knowledge_hits（只留技能/docs 文档/
  工坊资源并划拨保底名额：候选含 repos 时最多 2 个名额给工坊资源，词元
  碎片过滤）
- `brain/docsrc/` — 内嵌 docs 索引非空（≥20 篇/含 sdk/tween.md）、摄取建
  Concept 节点与 Mentions/Uses 边且幂等；`brain::tests` 锁 boot 概念计数
  （≥20）与 docs 检索命中（concept:doc:* 可被 query 命中）
- `brain/reposrc/` — 扫描（排序/跳过隐藏与二进制/@desc 兜底）、指纹（增删改
  变化且未变时稳定）、sync（建子图+Uses 边/存活文件保留访问史/消失文件连边
  下架/清空归零）；`brain::tests` 锁动态层端到端（仓库自带资源可检索可直读、
  外部增删文件经 refresh_repos 自动对齐）
- `brain/store/` — 冷却下沉/结构类拒绝下沉/按 id 提升/gzip 归档往返

前端 `src/assistant-window/tools.spec.ts` 覆盖 root 注入与决策中心回执 → 工具结果
转换（ok 透传/denied/needConfirm/缺 result 四态）；`agent.spec.ts` 覆盖提示词策略
门注入；`nlu.spec.ts` 覆盖单元计划守门/单元指令/单元循环/落库往返。真机验证项：
助手发起多步任务观察过程容器的大脑块（轨迹 + 单元逐个点亮），写操作观察确认
浮动条与批准后放行（brain.stats 对照 need_confirm/auto_execute 计数）。
