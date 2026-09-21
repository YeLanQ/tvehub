# 单元：漂移映射表（改什么 → 动哪些技能单元）

按"改动的代码区域"索引。同步动作完成后统一验证：`pnpm skills:check`。

| 代码变更 | 受影响单元 | 同步动作 |
|---|---|---|
| `src/lib/api.ts` 新增/删除方法 | tve-api-usage 对应 facade-*.md 契约表 | 加/删条目（方法名+后端命令名+一句话）；新增方法必须在**同一提交**里有真实调用点，否则在单元"使用例"标注"暂无调用点" |
| `src/lib/api.ts` 类型变更 | 同上 + facade-*.md 类型行 | 更新类型字段清单 |
| 新增后端命令 | facade-*.md + tve-app-operations/references/editor-commands.md | 门面条目 + 若暴露为用户操作，命令清单加行 |
| `src/app/commands/*` 增删命令/改 args | editor-commands.md（33 条清单）+ commands-registry.md 使用例 | 命令表增删改；快捷键变更同步 editor-commands 快捷键表 |
| `src/framework/scripting/tve.d.ts` / `src/runtime/core/tve.ts` | tve-sdk-scripting 各单元契约段 + tve-engine-interfaces/sdk-*.md | 签名速查表；跑 `pnpm gen:api-docs` 重生成 public/docs/sdk/api.md |
| `src/framework/prototype/**` 新节点类型 | tve-engine-interfaces/prototype-model.md 必做清单 + tve-app-operations editor-viewport（添加节点子菜单） | 按 prototype-model 的必做清单逐项 |
| `src/runtime/**` 模块增删导出 | tve-engine-interfaces/player-runtime.md 模块清单 + smoke-runtime-modules 断言 | 清单行 + 套件断言**同步改**（这是契约不是回归） |
| 帧循环顺序（player.mjs） | player-runtime.md 帧循环段 | 顺序图重画 + smoke-script-hooks 过一遍 |
| `vitest.config.ts` 阈值/口径 | tve-unit-testing/coverage-buckets.md 分桶表 | 表格 + **负向验证**（临时设 100 确认会拦）记录 |
| `package.json` scripts / 门禁链 | tve-unit-testing/gates.md + tve-local-ci/gate-chains.md | 两处链路图同步；ci-local STEPS 表若动，同步 gate-chains |
| 检查器分区/工具栏/右键菜单/快捷键 | tve-app-operations 对应单元操作面 | 操作表增删；入口 `文件:行号` 回填 |
| 图节点注册表（nodeRegistry/opRegistry） | tve-app-operations/graph-nodes.md 类型全表 | 表格行 |
| 白板工具/文件管理规则 | whiteboard-usage / whiteboard-files | 操作表；改名/防覆盖规则变更重点核对 |
| spec 新增/删除（含把推荐 spec 落地） | 引用它的单元测试例段 + skills:check 告警消一档 | 推荐写法升级为"真实测试例"，从告警清单摘除 |
| tests/README.md、tests/ISSUES.md | tve-unit-testing SKILL.md 现状锚点 | 数字（用例数/套件数/P0 数）对齐 |

## 校验器的边界（人工兜底项）

校验器拦不住的三类语义漂移，靠评审自查：
1. 方法改名但文件行数恰好不变（行号仍"有效"）；
2. 描述性陈述失真（如"当前 31 个 P0"变成 32）——涉及数字的陈述尽量指向
   可跑的命令（`pnpm smoke --list`）而非写死；
3. 使用例代码与实际签名不一致（tve.d.ts 变更后模板代码未跟）——SDK 变更时
   逐个跑一遍单元里的模板片段语法（transpile 级检查即可）。
