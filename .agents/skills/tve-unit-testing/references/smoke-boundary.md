# 边界：什么时候写 smoke 而不是单测

## 判定

| 被测对象 | 去处 |
|---|---|
| framework/ui-kit 纯逻辑、组件（无渲染器/IPC） | vitest 单测（本技能其余模式） |
| WebGL/WebGPU 渲染链路、EditorEngine 壳、SceneSynchronizer | smoke（`src/framework/engine/**`、`render/**` 被覆盖率口径显式排除） |
| `src/runtime/**`（播放侧引擎源） | smoke——vitest exclude 掉了 src/runtime |
| public/engine 产物链接/导出面 | smoke（.mjs 套件 node 直跑产物） |
| Tauri 真机 IPC 流程 | 手工 + devtools，不自动化 |

依据：vitest.config.ts exclude `src/runtime/**` + coverage include/exclude 注释、
tests/README.md 三层表。

## smoke 套件约定

- 位置：`scripts/smoke/tracker/smoke-*.{mjs,ts}`，**动态发现零注册**。
  `.mjs` = node 直跑（import public/engine 产物）；`.ts` = `vite build --ssr`
  打包编辑器源码后跑（产物在 `.tmp-smoke/<id>/`）。
- 头部注释写描述 + `// @priority P0|P1|P2`（registry 只扫前 30 行，**缺省 P1**；
  P0 必须 `pnpm test:regression:core` 全绿）。
- 断言协议：harness 的 `ok(cond, "说明")` 计数，结尾必须 `finish()`——runner 靠
  输出行「结果：X 通过，Y 失败」解析，任一失败 exit 1。
- harness（`scripts/smoke/harness.mjs`）提供：`engineURL/runtimeURL/coreURL(rel)`
  （产物 URL）、`installDomShim()`（node 跑 DOM 依赖模块的垫片）、`createSuite()`。

## 测试例（新增套件的模板步骤）

1. 复制一份现有 `smoke-*.ts`（推荐参照 `smoke-script-hooks.mjs`——它演示了
   shim 模块 + 用户脚本加载 + 生命周期时序断言）。
2. 头部：一行描述 + `// @priority P0`（核心路径才 P0；低频长耗时可 P2）。
3. 主体：`const { ok } = await createSuite(id)` 风格取断言器，逐条 ok()；
   结尾 `finish()`。
4. 文件丢进 tracker/ 即被发现；`pnpm smoke <id>` 单跑确认，再跑
   `pnpm test:regression:core` 确认 P0 面没被拖红。

## P0 现状（改引擎导出面时对照）

`smoke-runtime-modules.mjs` 断言**每个引擎模块的导出面**（如 particles.mjs 必须导出
`createGlslParticleMaterial`/`FADE_OUT_FRACTION`）——给 src/runtime 模块增删导出时
该套件会立刻红，属契约同步点而非回归。P1 已知漂移三套件见 tests/ISSUES.md。
