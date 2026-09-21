# 单元：决策矩阵（边界细则）

## 绿灯操作清单（直接执行，无需请示）

| 操作 | 约束 |
|---|---|
| 读文件/搜索/探索 | 用完即弃的中间产物放 .tmp*（已 gitignore） |
| 改源码/改技能文档/改脚本 | 遵守小文件口径（软 200/硬 260 行，skills:check 会拦） |
| 跑 pnpm test:unit / vitest run <file> | 失败先修再继续 |
| 跑 pnpm test:regression:core / smoke 单套件 | P0 红不带病收尾 |
| 跑 pnpm ci:local（含 --full） | --skip 只用于快速迭代并声明 |
| 补测试（含把推荐 spec 落地） | 四类输入；framework 模块同步加阈值桶 + 负向验证 |
| 修技能文档引用/新增单元 | 三段式（契约+使用例+测试例）齐全 |

## 黄灯操作清单（必须当轮获得用户明确授权）

| 操作 | 问什么 |
|---|---|
| git commit / push | "提交吗？"（推三平台是 push 的固定后果，要一并确认） |
| 依赖增删升级（package.json / Cargo.toml） | 说明动机、替代方案、影响面 |
| 版本变更（pnpm version:bump） | 目标版本号 |
| 删除文件/目录（含清 .tmp 之外的东西） | 列清单确认 |
| 改公共配置（tauri.conf/vite.config/tsconfig/vitest 阈值） | 说明理由；阈值改动必须附负向验证结果 |
| 对外发布（LanShare、构建产物交付） | 明确目标与范围 |
| src-tauri Rust 侧改动 | Rust 无本地单测覆盖，需说明验证方式（手工项） |

## 红灯清单（拒绝并说明）

- 修改/删除 `scripts/check-*.mjs`、`scripts/ci-local.mjs`、`scripts/smoke/runner.mjs`
  的判定逻辑来让链路变绿；
- 把真实失败写进 tests/ISSUES.md 的"已知漂移"（ISSUES 只收确认为契约漂移的项）；
- 绕过 src/lib 门面直连 Tauri API（layers 会拦，也不该试）;
- 在技能文档/代码里写本机绝对路径、token、内网地址；
- `git add -f` 被 .gitignore 的产物（public/engine、coverage、reports）。

## 判定原则

1. **可逆性优先**：能在同一会话内无损撤销的 → 绿灯；出工作区（提交/推送/发布）
   或动共享状态的 → 黄灯。
2. **授权不跨任务**：用户上轮说了"提交"，不代表本轮可以顺手 push 或再 commit。
3. **门禁是裁决者**：绿灯操作做完仍以 ci:local 结果为准，不因"我确认过"跳过。
4. **模糊即黄灯**：一个操作既像绿灯又像黄灯时，按黄灯处理并给选项。
