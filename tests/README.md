# 测试指南（单元 / 覆盖率 / 回归 / 报告归档）

本仓库的测试分三层，各有独立入口，全部本地可跑、不依赖 CI：

| 层 | 工具 | 入口 | 说明 |
| --- | --- | --- | --- |
| 单元/组件测试 | vitest + @vue/test-utils + jsdom | `pnpm test:unit` | UI 组件与引擎纯逻辑模块 |
| 覆盖率 | @vitest/coverage-v8 | `pnpm test:coverage` | 分桶阈值门禁（不达标退出码非 0） |
| 回归测试 | scripts/smoke 自研框架 | `pnpm test:regression`（全量）/ `pnpm test:regression:core`（P0 核心） | 34 个冒烟套件，运行时/编辑器双链路 |
| 一键全跑 | scripts/test/run-all.mjs | `pnpm test:all` | 覆盖率 + 全量回归 + 报告按日期归档 |

## 快速上手

```bash
pnpm test:unit               # 单元测试（单次全量，~10s）
pnpm test:watch              # 监听模式
pnpm test:coverage           # 覆盖率 + 阈值检查（HTML/XML/JSON 三份报告 → coverage/）
pnpm test:regression         # 全量回归（34 套件，~25s）
pnpm test:regression:core    # P0 核心回归（31 套件，必须全绿——日常提交口径）
pnpm test:all                # 一键全跑 + 归档（reports/<日期>/）
pnpm smoke                   # 交互菜单选套件（原入口不变）
pnpm test:baseline           # 重录性能基线（reports/perf-baseline.json）
```

## 单元测试约定

配置在根目录 `vitest.config.ts`（有意独立于 `vite.config.ts`——后者挂着模板索引、
许可证同步、主题生成等产物生成插件和 Tauri 资产中间件，跑测试不应触发它们）。

- **测试与被测文件同目录**，命名 `*.spec.ts`（如 `src/ui-kit/components/Slider.spec.ts`），
  vitest 按 `src/**/*.spec.ts` 收集；`src/runtime` 不参与。
- 只 import，不用全局（`globals: false`）：`describe/it/expect` 从 `vitest` 导入。
- 挂载用 `@vue/test-utils` 的 `mount`；环境为 jsdom，浏览器补丁（PointerEvent、
  指针捕获、matchMedia、ResizeObserver、scrollIntoView）统一在 `src/test/setup.ts`。
- 每条用例后自动卸载组件并复位 ui-kit 全局单例（toast / confirm / prompt /
  ctxMenu / dracoCompress），见 `src/test/setup.ts`。
- **Teleport 到 body 的浮层**（ComboBox / MultiSelect / ContextMenu / 对话框 /
  ToastHost / CullingMaskField 下拉）不在 `wrapper` 里，直接查 `document` 并用原生
  `dispatchEvent` 触发事件；异步开合后用 `flushPromises()` 等一拍。
- 定时器行为用 `vi.useFakeTimers()` + `vi.advanceTimersByTime()`，afterEach 里
  `vi.useRealTimers()`。
- **引擎模块测试**（`src/framework/**`）：只测纯逻辑（数据模型 / 解析器 / 收敛 /
  求值器 / 数学），不 mount、不开渲染器；three 的核心（几何/数学/场景图）headless
  可用，WebGL/WebGPU 专属路径留给 smoke。外部依赖（TSL 库、Tauri API、store）
  按「注入」或「单例桩」mock，不发真实请求。
- 类型口径：测试文件在根 tsconfig（strict、lib ES2020）下参与 `vue-tsc --noEmit`，
  不要用 ES2021+ 的 API（如 `Array#at`）。
- 用例之间不互相依赖、可重复跑、无副作用；正常 / 边界 / 异常 / 空值四类输入
  都要有对应用例（各 spec 文件即按此组织）。

## 覆盖率

- 口径 = **单元可测面**：`src/ui-kit/**`、`src/components/**`、`src/framework/**`
  （排除 engine/ 渲染链路、render/、physics/backend/ WASM、model worker——它们归
  smoke 与手工验证）。`src/app` 视图层暂不在口径内（浮层组件除外，后续随 spec
  增补逐步纳入）。
- 阈值在 `vitest.config.ts` 的 `coverage.thresholds`（vitest 5 glob 键形式，每个
  键一个独立结算桶）：
  - **基元核心 + 各纯逻辑模块**（prototype 基元/工厂/层级/FSM/场景原型/动画剪辑/
    TSL 解析/阴影配置/逻辑设置/地形纯逻辑）：语句 90 / 分支 85；
  - **prototype 派生层宽桶**（nodes/ 组件描述符等）：75/70；
  - **ui-kit 组件层**：70/60（当前基线 ~74/64，目标逐步提到 80/75）；
  - 其余 framework 模块不设门槛、仅入报告。
- 报告产物：`coverage/index.html`（HTML）、`coverage/cobertura-coverage.xml`
  （XML，Cobertura 格式）、`coverage/coverage-summary.json`（机器可读）。
- `pnpm dev` / `pnpm build` 门禁链跑的是无覆盖率的 `vitest run`（快）；阈值只在
  `test:coverage` / `test:all` 时结算。

## 回归测试（smoke）

- 套件在 `scripts/smoke/tracker/smoke-*.{mjs,ts}` 动态发现（.mjs = node 直跑网页
  运行时；.ts = vite --ssr 打包编辑器源码），无需注册。
- **优先级**：套件头部注释 `// @priority P0|P1|P2`（缺省 P1）：
  - **P0（31 个）**：核心路径，`pnpm test:regression:core` 必须**全绿**——日常
    提交 / 每次发版前都跑；
  - **P1（3 个：particles / particles-runtime / terrain）**：含已知契约漂移
    （见 [ISSUES.md](./ISSUES.md)），发版前跑全量时须过目失败项是否为已知；
  - P2：预留给低频/长耗时套件。
- 指定 `--report-dir <目录>` 时落盘 JUnit XML（`smoke-junit.xml`）+ 机器可读
  汇总（`smoke-summary.json`，含每套件耗时）。
- 新增回归套件：复制一份现有 `smoke-*.ts`，头部写描述与优先级，结尾
  `finish()`（统一入口靠「结果：X 通过，Y 失败」行解析断言数），文件丢进
  tracker/ 即被发现。

## 报告归档与趋势

`pnpm test:all`（`scripts/test/run-all.mjs`，跨平台纯 Node）：

1. 跑 `vitest run --coverage`；
2. 跑 `smoke --all`（写 JUnit + summary JSON）；
3. 归档到 `reports/<YYYY-MM-DD>/`：
   - `coverage/`（HTML + Cobertura XML + JSON 汇总）
   - `smoke/smoke-junit.xml`、`smoke/smoke-summary.json`
   - `summary.md`（人读总览：状态 / 覆盖率 / 通过数 / 性能偏差）
4. 追加 `reports/history.jsonl`（每行一次全跑的趋势流水，看覆盖率随日期变化）。

**性能基线**：`reports/perf-baseline.json` 记录每套件耗时；`pnpm test:all` 时超
基线 3× 的套件写进 summary 告警（不判失败——不同机器/负载不可比，偏差记录供
人工评估）。换机器或负载变化后 `pnpm test:baseline` 重录。

`reports/` 与 `coverage/` 均为本地产物，不入库（.gitignore 已排除）。
唯一例外：**安全/质量评审台账 `tests/AUDIT-LEDGER.json` 入库**（scripts/audit
扫描器的"设计内接受"记录，rule+file+代码签名三元组命中才生效，代码漂移自动失效；
新增接受项：`node scripts/audit/scan.mjs --accept <token> --reason "理由"`）。

## 维护守则

- 改了 `src/framework` 纯逻辑 → `pnpm test:unit`；改了渲染/运行时链路 →
  `pnpm test:regression:core` 起步。
- 新增引擎纯逻辑模块：写同目录 `*.spec.ts`，并视性质把它加进
  `coverage.thresholds` 的对应桶（核心 90/85 或宽桶 75/70）。
- 单测红了先修再提交（dev/build 门禁会拦）；smoke P0 红了必须当场处理，
  P1 红了先对 ISSUES.md 判断是否新增漂移。
- 每次发版前：`pnpm test:all`，归档留档，`reports/history.jsonl` 看趋势。
- 测试代码与业务代码同标准维护：命名清楚、注释讲「为什么测这个」、不写
  无断言的凑数用例。
