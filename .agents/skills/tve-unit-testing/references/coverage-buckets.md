# 覆盖率分桶阈值（vitest.config.ts L53-74）

## 当前分桶表

`coverage.thresholds` 是 **glob 键对象**，每个键一个独立结算桶（先具体文件键、后
`**` 宽桶，vitest 按键序优先匹配）。字段：statements/branches/functions/lines。

| 桶（glob 键） | 门槛（语句/分支/函数/行） |
|---|---|
| prototype 核心六文件：`Node.ts` `Transform.ts` `PrototypeRegistry.ts` `prefab.ts` `types.ts` `components/registry.ts` | 90 / 85 / 85 / 90 |
| `src/framework/factory/**`、`layers/**`、`fsm/**`、`scene/ScenePrototype.ts`、`animation/clip.ts`、`material/tsl/**`、`lighting/shadow.ts`、`logic/types.ts`、`terrain/{types,paint,sculpt}.ts` | 90 / 85 / 85 / 90 |
| `src/framework/prototype/**`（派生节点/组件描述符宽桶） | 75 / 70 / 70 / 75 |
| `src/ui-kit/**`、`src/components/**`（基线 ~74/64，目标 80/75） | 70 / 60 / 65 / 70 |
| 其余 framework 模块 | 不设门槛，仅入报告 |

口径（include）：`src/ui-kit/**`、`src/components/**`、`src/framework/**`；
排除：spec/d.ts/scss、`framework/engine|render/**`、`physics/backend/**`、
`model-decode-worker.ts`（渲染与 WASM 面归 smoke）。`src/app` 视图层暂不在口径内。

## 致命怪癖：数组分组写法被静默忽略

vitest 5.0.1 只认上面的 glob 键对象。`{ name, includes: [...] }` 的**数组分组写法**
展开后键变成 "0"/"1"，匹配不到任何文件、全局标量也取不到 → **不结算、不报错**，
阈值形同虚设（tests/ISSUES.md 怪癖 #12，已负向验证过）。

## 调阈值的正确流程

1. 改 `vitest.config.ts` 对应桶数值（新增纯逻辑模块 → 按性质进核心 90/85 或宽桶 75/70）。
2. **负向验证会拦**：临时把该桶设成 100，跑 `pnpm test:coverage`，确认以非零码退出；
   再改回目标值确认通过。没做过这一步的阈值改动视为未生效。
3. 跑 `pnpm test:coverage` 看该桶真实水位；报告在 `coverage/index.html`
   （HTML）、`cobertura-coverage.xml`、`coverage-summary.json`。

## 与门禁的关系

阈值只在 `pnpm test:coverage` / `pnpm test:all` 结算；`pnpm dev` / `pnpm build`
链里跑的是**无覆盖率的 `vitest run`**（快，不查阈值）——见 gates.md。
