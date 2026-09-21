---
name: tve-unit-testing
description: TvE Hub 单元测试模式与添加测试的操作规范：specs 与源文件同目录、无 vi.mock 的注入/单例桩风格、ES2020 类型口径、覆盖率分桶阈值、dev/build 门禁链、正常/边界/异常/空值四类用例组织。凡要写 *.spec.ts、补单测、调覆盖率阈值、被 vitest 或门禁拦下、问"这个要不要写测试"，一律先读本技能。
---

# 单元测试模式与添加测试

权威文档：`tests/README.md`（三层测试口径）与 `tests/ISSUES.md`（已知怪癖/漂移）。
本技能把它们转成操作规范；逐模式范例见 references/。

## 硬约定（违反任何一条都会被门禁或怪癖咬）

1. **位置与命名**：spec 与被测文件同目录同名，`Xxx.ts` → `Xxx.spec.ts`。vitest 按
   `src/**/*.spec.ts` 收集；`src/runtime` 不参与（归 smoke）。不叫 `*.test.ts`。
2. **显式导入**：`globals: false`——`import { describe, expect, it, vi } from "vitest"`。
3. **无 vi.mock**：全仓库 0 处。外部依赖用**构造注入**（传真实轻量实现）或
   **单例桩/复位**（beforeEach 清状态）。需要 spy 用 `vi.fn()` / `vi.spyOn`。
4. **Tauri 不可用**：jsdom 无 `__TAURI_INTERNALS__` → `isTauri()` 恒 false。
   只测浏览器直开分支的安全空操作；真机分支归手工/smoke。不要试图 mock invoke。
5. **类型口径**：spec 参与根 tsconfig（strict，lib ES2020）下的 `vue-tsc --noEmit`
   ——**禁用 ES2021+ API**（`Array#at`、`Object.hasOne` 之类都不行）。
6. **setup 不可挪**：`src/test/setup.ts` 必须在 src/ 下（composite 项目 TS6059）；
   它负责 jsdom API 补丁 + `enableAutoUnmount` + ui-kit 单例复位，写组件测试不用自己管卸载。
7. **覆盖率阈值是 glob 键对象**（vitest.config.ts L53-74）。数组分组写法会被
   **静默忽略**（不报错不结算）——改阈值必须负向验证（见 coverage-buckets.md）。
8. **四类输入**：正常/边界/异常/空值都要有用例（tests/README.md 既定组织法），
   不写无断言的凑数用例。

## 添加测试的标准流程

1. 判断归属：纯逻辑/组件且在 `src/ui-kit|components|framework` → 单测；
   渲染链路、引擎产物、WebGL/WebGPU、Tauri 真机 → smoke（references/smoke-boundary.md）。
2. 建同目录 spec，从 vitest 显式导入；选模式：
   - 组件 → references/pattern-components.md（Teleport 浮层走 document.querySelector）
   - 纯逻辑/工厂 → references/pattern-logic.md（注入真实依赖）
   - 单例 composable/store → references/pattern-singleton.md（fake timers + 复位）
3. 按四类输入组织 describe/it。
4. 验证：`pnpm vitest run src/path/Xxx.spec.ts` → 全量 `pnpm test:unit`。
5. 新增的是 framework 纯逻辑模块 → 把它加进 `coverage.thresholds` 对应桶
   （核心 90/85 或派生宽桶 75/70），并负向验证阈值真的会拦。
6. `pnpm dev` / `pnpm build` 前会自动跑 `vitest run`（门禁链，见 references/gates.md）；
   红了先修再提交。

## 现状锚点（2026-09）

- 46 个 spec / 351 例：framework 26、ui-kit 17（组件 12 + composable 5）、
  app 2（AssetTypeIcon / CullingMaskField）、docs-window 1。
- **无 spec 的单元**：src/app/stores/*、services/*、commands/*、src/lib 门面、
  SceneClient、graph-window、whiteboard-window。给它们补测试时的示范写法已内嵌在
  `tve-api-usage` 技能各单元文件的"测试例"段。
- smoke：34 套件，P0 31 个必须全绿；P1 3 个（particles/particles-runtime/terrain）
  已知契约漂移见 tests/ISSUES.md。

## 命令速查

```bash
pnpm vitest run src/ui-kit/components/Slider.spec.ts   # 单文件
pnpm test:unit        # 全量单测（dev/build 门禁同款）
pnpm test:watch       # 监听
pnpm test:coverage    # 覆盖率 + 阈值结算
pnpm test:regression:core   # smoke P0（必须全绿）
pnpm test:all         # 一键全跑 + reports/<日期>/ 归档
```

## 姊妹技能

- 各 API 单元的"测试例"索引（哪些有真实 spec、哪些给的是推荐写法）：`tve-api-usage`
- 引擎接口与 smoke 套件的对应关系：`tve-engine-interfaces`
- tve 脚本编写（模板内附验证流程）：`tve-sdk-scripting`
