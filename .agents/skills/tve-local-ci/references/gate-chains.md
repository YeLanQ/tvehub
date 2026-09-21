# 单元：门禁链细则

## 各步细节

**skills（check-skills.mjs）**：扫描 `.agents/skills/**` 全部 .md——
frontmatter（name=目录名、description 非空）；行数软上限 200/硬上限 260；
`src|scripts|tests|public` 前缀路径引用必须存在（`*.spec.ts` 缺失只告警——
那是"推荐补测"的示范；public/engine 构建产物不查；public/docs|repos|web-preview
缺失降级告警）；`path:line` 行号超文件总行 = 失败（引用失效）。
`--strict` 把告警也当失败。**设计原则：宁可漏报不可误报**——围栏代码块内的
路径是示例，不校验。

**types（vue-tsc）**：根 tsconfig（strict，lib ES2020）覆盖 src 全部 .ts/.vue
（**含 spec**）——测试里用 ES2021+ API（`Array#at`）在这步拦，不在 vitest。

**layers（check-layers.mjs）**：依赖方向白名单——`src/lib/**` 是唯一允许
import `@tauri-apps/*` 的层；业务层绕过 lib 门面直调 invoke 在此失败。

**unit（vitest run）**：无覆盖率（快）；阈值结算只在 `test:coverage` / ci:local
--full。分桶阈值与"数组分组写法静默忽略"怪癖：`tve-unit-testing`
references/coverage-buckets.md。

**smoke（runner.mjs --core）**：31 个 P0 套件，断言协议与新增套件三步：
`tve-unit-testing` references/smoke-boundary.md。P1（particles/particles-runtime/
terrain）**不在 core 口径**，已知漂移对照 tests/ISSUES.md。

## 超时与耗时基线

unit ~10s、smoke core ~25s、types 视增量（全量约 30-60s）、full（run-all）约
1-2 分钟。套件耗时超 perf-baseline 3× 只在归档 summary 告警（跨机器不可比）。

## 归档（--full 末步 = run-all.mjs）

1. `vitest run --coverage`（阈值结算，不达标非零退出）
2. `smoke --all`（JUnit + summary JSON）
3. 归档 `reports/<YYYY-MM-DD>/`（coverage/ + smoke/ + summary.md）
4. 追加 `reports/history.jsonl` 趋势流水
reports/ 与 coverage/ 均不入库。

## 测试例（这套 CI 自身的质量口径）

- check-skills.mjs 已实战自证：首跑即抓出 4 处文档漂移（占位符路径、不存在的
  smoke 套件名）——它自己就是自演化的测试例。
- ci-local.mjs 冒烟：`pnpm ci:local --only skills`（秒级）；未知步骤名参数
  应报错退出 1。
