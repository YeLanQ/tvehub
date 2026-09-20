# 前端单元 / 组件测试（vitest）

配置在根目录 `vitest.config.ts`（有意独立于 `vite.config.ts`——后者挂着模板索引、
许可证同步、主题生成等产物生成插件和 Tauri 资产中间件，跑测试不应触发它们）。

## 运行

```bash
pnpm test            # 单次全量
pnpm test:watch      # 监听模式
pnpm test:coverage   # 覆盖率（v8，text + html 报告）
```

已挂进门禁链：`pnpm dev` 与 `pnpm build`（含 tauri 的 beforeDev/BuildCommand）都会先
`vitest run`，红了直接断链不启动/不构建；临时跳过用 `pnpm exec vite`。

## 约定

- **测试与被测文件同目录**，命名 `*.spec.ts`（如 `src/ui-kit/components/Slider.spec.ts`），
  vitest 按 `src/**/*.spec.ts` 收集；`src/runtime` 不参与。
- 只 import，不用全局（`globals: false`）：`describe/it/expect` 从 `vitest` 导入。
- 挂载用 `@vue/test-utils` 的 `mount`；环境为 jsdom，浏览器补丁（PointerEvent、
  指针捕获、matchMedia、ResizeObserver、scrollIntoView）统一在 `src/test/setup.ts`
  （放 src 下归根 tsconfig 管；放仓库根会撞 tsconfig.node.json 的 composite 越界约束）。
- 每条用例后自动卸载组件并复位 ui-kit 全局单例（toast / confirm / prompt /
  ctxMenu），见 `src/test/setup.ts`；用例内不需要手工清理这些状态。
- **Teleport 到 body 的浮层**（ComboBox / MultiSelect / ContextMenu / 三个对话框 /
  ToastHost）不在 `wrapper` 里，直接查 `document` 并用原生 `dispatchEvent` 触发事件；
  异步开合后用 `flushPromises()`（来自 `@vue/test-utils`）等一拍。
- 依赖定时器的行为（toast 自动消失等）用 `vi.useFakeTimers()` +
  `vi.advanceTimersByTime()`，并在 `afterEach` 里 `vi.useRealTimers()`。
- 类型口径：测试文件在根 tsconfig（strict、lib ES2020）下参与 `vue-tsc --noEmit`，
  不要用 ES2021+ 的 API（如 `Array#at`），保证 `pnpm build` 不被测试类型问题卡住。
- Tauri 相关组件（TitleBar / WindowControls 等）在 jsdom 下 `isTauri()` 恒为 false，
  默认覆盖「浏览器直开」分支即可；如需测 Tauri 分支，`vi.mock("@tauri-apps/api/window")`。

## 放哪些测试

- **组合式函数 / 纯逻辑**（`composables/*.ts`）：直接测状态与返回值，不挂载。
- **展示组件**：挂载后断言渲染结果、props 透传、事件回抛（`emitted()`）。
- **浮层 / 对话框**：走 composable 驱动（如 `confirm({...})`）再断言 DOM 与 Promise 兑现。
- 不为重 three.js / Tauri IPC 的视图层（Viewport、docks 等）写挂载测试——
  那部分归 `pnpm smoke`（运行时冒烟）与手工验证；可测的是拆出来的纯逻辑模块。
