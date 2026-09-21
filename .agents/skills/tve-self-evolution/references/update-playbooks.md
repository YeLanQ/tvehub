# 单元：更新手册（四类高频变更的分步剧本）

## 剧本 A：新增后端命令 + 门面方法

1. Rust `#[tauri::command]` + 注册（src-tauri/src/lib.rs）。
2. `src/lib/api.ts` 加方法（camelCase ↔ snake_case，注释写契约）。
3. 同批改 tve-api-usage 对应 facade 单元：契约表加行；调用点落码后回填 `文件:行号`。
4. 若命令需要分层豁免/白名单，跑 `pnpm ci:local --only layers` 确认。
5. 有用户操作语义 → editor-commands.md 命令表加行。
6. 验证：`pnpm skills:check && pnpm ci:local --only types,unit`。

## 剧本 B：tve SDK 变更（最重的一份契约）

1. **两处镜像同步**：`src/framework/scripting/tve.d.ts`（契约）与
   `src/runtime/core/tve.ts` 运行时实现；VERSION 按语义化提升。
2. `pnpm gen:api-docs` 重生成 `public/docs/sdk/api.md`（勿手改）。
3. tve-sdk-scripting 对应单元的契约速查表 + 模板代码过语法；
   若新能力值得示范 → 在 `public/repos/code/` 加示例脚本（首行 `// @desc:`），
   单元"使用例"引用它。
4. 运行时回归：`pnpm test:regression:core`；生命周期语义动过 → 重点
   smoke-script-hooks.mjs。
5. skills:check 确认 sdk-*.md 引用的行号没漂。

## 剧本 C：覆盖率阈值 / 门禁链调整

1. `vitest.config.ts` 改阈值（**glob 键对象**，数组写法静默忽略）。
2. **负向验证**：临时把目标桶设 100 → `pnpm test:coverage` 确认非零退出 →
   改回目标值确认通过。不做这步 = 阈值可能形同虚设。
3. 同步 coverage-buckets.md 分桶表 + gates.md 链路图。
4. 若动 ci-local STEPS：同步 tve-local-ci/gate-chains.md，并
   `pnpm ci:local --only <改的步>` 冒烟。

## 剧本 D：把"推荐补测的示范 spec"落地成真实测试

1. 从 skills:check 告警清单挑一条（如 `src/app/stores/log.spec.ts`）。
2. 按 `tve-unit-testing` 对应 pattern 写 spec（四类输入齐全，参照单元里的
   示范片段——它们本来就是按可落地标准写的）。
3. 单元文件的测试例段把"当前无 spec，推荐写法"升级为引用真实 spec（保留
   原示范可删）。
4. framework 新模块 → 加进 coverage.thresholds 对应桶 + 负向验证。
5. `pnpm test:unit` 全绿后跑 `pnpm skills:check`——该条告警应消失。

## 演化记录

- 首次启用（2026-09-21）：check-skills 首跑抓出 4 处漂移（player-runtime/
  runtime-comm 的占位路径与不存在套件名、scene-query-comm 示例路径），
  当场修复归零——检测网有效性已实证。
