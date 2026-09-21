# 单元：失败分诊手册（哪步红 → 查什么 → 修什么）

## skills 红

| 症状 | 原因 | 处置 |
|---|---|---|
| `引用路径不存在：src/...` | 代码移动/删除后技能文档没跟上（**这正是自演化信号**） | 走 `tve-self-evolution` 的 drift-map 找到应更新的单元，改引用或改回路径 |
| `行号引用失效：x.ts:N` | 文件行数变动使行号越界 | 重新定位行号；找不到就在文档里降级为不带行号的引用 |
| `name 与目录名不一致` / frontmatter 缺失 | 新技能目录结构错 | 目录名 = name = kebab-case，frontmatter 三件套补齐 |
| `行数超限` | 单元文件写大了 | 按单元拆 references/（软 200 告警、硬 260 失败） |

## types 红

- ES2021+ API（`Array#at` 等）——通常在**新写的 spec** 里（lib ES2020 限制）。
- 类型不匹配：优先看自己改动的文件；spec 与业务代码同标准。

## layers 红

新代码直接 import 了 `@tauri-apps/*`——把调用下沉到 `src/lib/api.ts`（或
scene-api/ui-state），业务层改走门面。参考既有形态：`tve-api-usage` SKILL.md
分层地图。

## unit 红

- 先跑单文件复现：`pnpm vitest run <file.spec.ts>`。
- 用例间串扰（单例未复位）→ 对照 `tve-unit-testing` pattern-singleton.md。
- 阈值相关（只在 --full 的 coverage 步）→ 负向验证流程见 coverage-buckets.md。

## smoke 红

- **P0 红 = 当场处理，不带病提交**。单跑复现：`pnpm smoke <id>`；
  定位：`pnpm smoke --list` / `--filter 词`。
- 改了 src/runtime 导出面 → `smoke-runtime-modules.mjs` 红是**契约同步点**：
  去该套件补/改导出面断言，不是改套件迁就代码。
- 改了帧循环/生命周期时序 → `smoke-script-hooks.mjs`。
- 换了产物结构 → 先 `node scripts/build-runtime.mjs` 再跑（stale 产物会假红）。

## 全红的处理顺序

skills（秒级）→ types → layers → unit → smoke：从快到慢修，前面的绿了再修后面；
不要并行大改。修复后**整链重跑** `pnpm ci:local` 拿全绿再提交。

## 测试例

- 本手册的可执行校验就是 `pnpm ci:local --only skills`（秒级自检）。
- 已知漂移基线：tests/ISSUES.md（P1 三套件）；新增漂移必须记进去。
