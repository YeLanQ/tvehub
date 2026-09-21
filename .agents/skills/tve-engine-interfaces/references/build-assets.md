# 单元：buildRuntime 构建管线与外部资产（extra/）

## 契约

`scripts/build-runtime.mjs` 导出 `buildRuntime(why = "")`（inFlight 串行化并发调用），
**三步固定顺序**：

1. `vendorPreviewLoaders()`：three 三构建（core/module/webgpu min.js）+ 模型加载器
   + draco JS 解码器 ← node_modules/three → public/engine；
2. `copyExtraAssets()`：`src/runtime/extra` → public/engine **字节级原样**（.gitattributes
   `-text` 保真；README.md 不拷）；
3. vite lib 模式编译 `src/runtime/**.ts` → `.mjs`（AUTO-GENERATED 横幅；three 外部化为
   相对说明符；说明符相对化；**落盘前内容比对幂等**——一致不写，防 watcher 抖动）。

校验：`verifyOutput`（无 `import.meta.url` 残留/裸 three 残留，未命中显式失败）；
`scripts/check-runtime.mjs` 独立校验横幅/外部化一致性。
触发点：`pnpm build` 链第一步 + vite.config.ts `runtimeBuildPlugin()`（dev 启动全量
再生 + 源变化防抖重建）。**public/engine 不入库**，任何机器一次全量再生。

**extra/ 资产清单**（外部资产事实源，手动维护）：
- `runtime/physics-engines/`：rapier.mjs（@dimforge/rapier3d-compat 产物）、
  jolt.mjs（wasm 内联）、ammo/ 三件套（scripts/make-ammo-esm.cjs 生成）；
- `runtime/loaders/basis/`：basis_transcoder.js/.wasm（KTX2 转码）；
- `runtime/loaders/draco/`：draco_decoder.wasm + draco_wasm_wrapper.js
  （draco_decoder.js 由 vendor-preview-loaders.mjs 生成入库，不在 extra）。

**产物清单**：`src/generated/web-preview-files.ts`（gen:preview-files 自动扫描，
勿手改）；`WEBGPU_FILES = [three.webgpu.min.js, particleNodeMaterial.mjs,
glslToTsl.mjs, nodeMaterialHooks.mjs]`。
**wasm 特判**：导出链路（文本 IPC）会损坏 wasm 二进制 → 导出始终排除 wasm 版，
用 JS 版解码器（scripts/gen-web-preview-files.mjs）。

## 使用例

改 src/runtime 任一源文件后：dev 下自动重建（防抖）；CI/构建走 `pnpm build`
链；手动全量再生 `node scripts/build-runtime.mjs`。物理引擎升级 =
换 extra/ 下产物 + 重扫清单。

## 测试例

真实测试例：
- `scripts/check-runtime.mjs` —— 产物横幅/外部化一致性（build 链与手动可跑）；
- `pnpm test:regression:core` —— P0 套件群直连 public/engine 产物（harness
  `engineURL/coreURL`），产物损坏/缺失在此第一时间暴露；
- `pnpm test:all` 归档 reports/（coverage + smoke + summary + history.jsonl）。

产物相关失败排查顺序：产物是否存在 → check-runtime → smoke P0 →
web-preview-files 清单一致性（见 runtime-comm.md 已知坑）。
