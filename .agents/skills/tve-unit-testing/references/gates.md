# 门禁链与命令全景

## dev/build 门禁链（package.json）

```
pnpm dev   = sync-version → vitest run → vite
pnpm build = sync-version → build-runtime → gen-web-preview-files → sync-licenses
             → gen-lan-theme → vue-tsc --noEmit → check:layers → vitest run → vite build
```

- 单测挂在 dev 和 build 链上：**spec 红了连 dev server 都起不来**，先修再提交。
- 链里的 `vitest run` **无覆盖率**（快）；阈值结算只在 test:coverage / test:all。
- `check:layers`（scripts/check-layers.mjs）：只有 `src/lib/**` 可 import
  `@tauri-apps/api/*`——新代码绕过 lib 门面会在 build 链被拦。

## 命令速查

| 命令 | 内容 |
|---|---|
| `pnpm vitest run <file.spec.ts>` | 单文件（最快反馈） |
| `pnpm test:unit` / `pnpm test` | 全量单测（~10s） |
| `pnpm test:watch` | 监听模式 |
| `pnpm test:coverage` | 覆盖率 + 阈值结算（不达标非零退出） |
| `pnpm test:regression` | smoke 全量 34 套件（~25s） |
| `pnpm test:regression:core` | smoke P0 31 套件（**必须全绿**，日常提交口径） |
| `pnpm smoke` / `pnpm smoke <id>` | 交互菜单 / 指定套件（`--list` 列表、`--filter 词`、`--priority P1`） |
| `pnpm test:all` | coverage + smoke 全量 + 归档 |
| `pnpm test:baseline` | 重录性能基线 |

smoke runner 细节：`--skip-build`、`--fail-fast`、`-q`、`--report-dir <dir>`
（落 smoke-junit.xml + smoke-summary.json）。

## 报告归档与趋势

`pnpm test:all`（scripts/test/run-all.mjs）：

1. `vitest run --coverage`；
2. `smoke --all`；
3. 归档 `reports/<YYYY-MM-DD>/`：coverage/、smoke/、summary.md；
4. 追加 `reports/history.jsonl` 趋势流水（覆盖率随日期变化）。

性能基线 `reports/perf-baseline.json`：套件耗时超基线 3× 只在 summary 告警不判失败
（跨机器不可比）；换机器后 `pnpm test:baseline` 重录。`reports/` 与 `coverage/`
均不入库（.gitignore）。

## 失败处置口径（tests/README.md 维护守则）

- 单测红 → 先修再提交（门禁会拦）。
- smoke P0 红 → 当场处理，不带病提交。
- smoke P1 红 → 对照 `tests/ISSUES.md` 判断是否已知漂移（当前 3 个已知：
  particles / particles-runtime / terrain）；新漂移要记进 ISSUES.md。
