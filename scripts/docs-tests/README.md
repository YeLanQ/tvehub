# 文档代码块测试（doctest）

`public/docs/**/*.md` 中标记为 ` ```ts tve ` 的代码块是**被测代码**：每一块都会经
过「类型检查 → 真实执行」两级验证，等价于内嵌在文档里的测试单元。运行：

```bash
pnpm docs:test
```

## 标记语法

普通 ` ```ts ` 代码块不进测试。在语言标记后加 `tve` 即纳管：

````md
```ts tve
import { math } from "tve";

const v = math.add(math.v3(1, 2, 3), math.v3(1, 1, 1));
v; // => {"x":2,"y":3,"z":4}
```
````

块内以表达式语句 + 行尾注释 `// => 期望值` 声明断言（doctest 风格）。期望值语法：

- JSON 字面量：`5` / `"abc"` / `true` / `null` / `{"x":2}` / `[1,2]`
- 特殊关键字：`undefined` / `NaN` / `Infinity` / `-Infinity`
- 数值按近似比较（绝对误差 ≤ 1e-6），避免浮点尾数漂移

## 两级验证

| 级别 | 内容 | 拦截什么 |
| --- | --- | --- |
| 类型检查 | 每块按 strict TS 单文件编译，模块说明符 `tve` 映射 `src/framework/scripting/tve.d.ts` | 拼错 API、签名不匹配、示例类型不成立 |
| 真实执行 | 块转译为 ES2020 ESM 后在 Node 中 `import`，`"tve"` 重定向到 `src/runtime/core/tve.ts` 的编译产物；`// =>` 断言逐一核对 | 示例运行报错、返回值与文档声称不符 |

执行环境说明：

- 运行时产物缺失/陈旧时自动经 `scripts/build-runtime.mjs` 重建（幂等）；
- tve 运行时未注入宿主时安全空转（`engine.scene.find` 返回 `null` 等）——文档中
  依赖场景宿主的示例只做类型级验证或断言空转语义；
- 块执行期间 `console.log` 被静音（`engine.log` 会透传），`warn/error` 保留。

## 约定（写示例时遵守）

1. 块必须**原样可复制**进用户项目：不引用 doctest 私有符号、不写跨脚本相对
   `import type`（类型检查解析不到）；跨组件通信示例用 `getComponent("类名")` 演示；
2. 断言表达式必须是独立语句（行尾 `// =>` 紧跟其后）；
3. `scripts/api-docs/examples/*.md` 里的示例块同样用 ` ```ts tve ` 标记——它们会被
   `pnpm gen:api-docs` 注入 `public/docs/sdk/api.md`，随本测试一并纳管。

## 文件

| 文件 | 职责 |
| --- | --- |
| `extract-blocks.mjs` | md → 块清单（file:line 定位 + 源码） |
| `type-check.mjs` | 块级 TS 类型检查（createProgram 批量） |
| `run-blocks.mjs` | 块执行：转译 + "tve" 重定向 + 逐块 import |
| `expect.mjs` | `__docExpect` 断言比较（数值近似/深比较） |
| `cli.mjs` | 入口编排与汇总报告 |
