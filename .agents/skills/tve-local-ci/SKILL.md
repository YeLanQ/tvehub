---
name: tve-local-ci
description: TvE Hub 本地自动 CI：pnpm ci:local 一键门禁链（技能文档校验→类型检查→分层门禁→单元测试→P0 核心回归），失败分诊手册与报告归档。凡提交前自检、发版前全量验证、门禁红了不知先修哪个、或要确认改动没破坏任何链路，一律先跑本技能定义的链。
---

# 本地自动 CI 系统

**一条命令**：`pnpm ci:local`（提交前最低口径）；`pnpm ci:local --full`（发版前，
追加覆盖率阈值结算 + smoke 全量 + reports/<日期>/ 归档）。脚本：
`scripts/ci-local.mjs`——与 package.json 既有脚本一一对应，失败即停、退出码非 0。

## 链路与各步职责

| 步骤 | 命令 | 拦什么 |
|---|---|---|
| skills | `node scripts/check-skills.mjs` | 技能文档漂移：引用路径/行号失效、frontmatter 损坏、文件超限（自演化检测网，见 `tve-self-evolution`） |
| types | `pnpm exec vue-tsc --noEmit` | 类型错误（根 tsconfig strict；含 spec 文件——ES2020 口径在这里拦） |
| layers | `node scripts/check-layers.mjs` | 越层依赖（只有 src/lib 可 import @tauri-apps/*） |
| unit | `pnpm exec vitest run` | 351 例单元/组件测试 |
| smoke | `node scripts/smoke/runner.mjs --core` | 31 个 P0 套件（运行时/渲染/引擎产物链路）必须全绿 |

变体：`--only skills,unit` 只跑指定步；`--skip smoke` 快速迭代（输出会注明
"不构成完整门禁结论"）；`--full` 见上。

## 与既有门禁的关系（不重复造口径）

- `pnpm dev` = sync-version → vitest run → vite（单测前置门禁）
- `pnpm build` = sync-version → build-runtime → gen:preview-files → licenses →
  theme → vue-tsc → check:layers → vitest run → vite build
- ci:local 的差异点：**加了 skills 校验步 + smoke P0 + 可选归档**，构成
  "提交前/发版前"的完整本地闭环；CI 步骤定义在 scripts/ci-local.mjs 的 STEPS 表。

## 细则

- 分步细则（阈值/分层规则/smoke 协议）：references/gate-chains.md
- 失败分诊（哪步红 → 查什么 → 怎么修）：references/ci-runbook.md
- 报告归档与趋势（--full 产物）：`pnpm test:all` 同链路，见 `tve-unit-testing`
  技能 references/gates.md

## 姊妹技能

文档漂移的"更新动作"：`tve-self-evolution`；Agent 何时跑哪条链：`tve-agent-autonomy`。
