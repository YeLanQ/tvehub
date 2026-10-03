# 单元：buildRuntime 构建管线与外部资产（extra/）

## 契约

`runtime/scripts/engine.mjs` 导出 `buildRuntime(why = "")`（inFlight 串行化并发调用），
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
- `runtime/physics-engines/`：rapier.mjs（@dimforge/rapier3d-compat 产物，wasm
  base64 内联）、jolt.mjs（wasm 内联）、ammo/ 三件套（scripts/make-ammo-esm.cjs
  生成；ammo-esm.mjs 为钩子化最终形态，ammo-wasm-b64.mjs 仅作构建期 wasm 抽取源）；
- `runtime/loaders/basis/`：basis_transcoder.js/.wasm（KTX2 转码）；
- `runtime/loaders/draco/`：draco_decoder.wasm + draco_wasm_wrapper.js
  （draco_decoder.js 由 vendor-preview-loaders.mjs 生成入库，不在 extra）。

**产物清单**：`src/generated/channel-runtimes.ts`（gen:channel-runtimes 自动扫描
双渠道，勿手改）；`WEBGPU_FILES = [three.webgpu.min.js, particleNodeMaterial.mjs,
glslToTsl.mjs, nodeMaterialHooks.mjs]`。

**wasm 文件化**（runtime/scripts/wasm-fileize.mjs，engine.mjs 构建链步骤）：物理
胶水不再内联 wasm——rapier/jolt 经锚点改写为全局钩子
`__tveInstantiateWasmFile(path, imports)` 加载同目录 .wasm 文件（与微信桥接层
同一契约；安装方 = src/framework/physics/wasm-file-hook.ts：播放器主线程/物理
Worker 由 physics.ts 顶层安装，编辑器 canvas 由 ammoBackend 安装），ammo.wasm 由
extra b64 抽取落盘；dev 产物根 = public/，单页产物 wasm 进内联资产表经 fetch
垫片供数，多文件产物 .wasm 一律真实文件落盘（gzip 归档例外：Worker 命中不到
主线程垫片）。Draco/Basis 解码器切 wasm 形态（three 主线程取数 postMessage 进
解码 Worker），draco_decoder.js 不随产物（manifest EXPORT_EXCLUDED）。
**多文件 gzip 特判**：.wasm 不进 assets.gzip（Rust web 管线 binaries 分流）。

## 使用例

改 src/runtime 任一源文件后：dev 下自动重建（防抖）；CI/构建走 `pnpm build`
链；手动全量再生 `node runtime/scripts/engine.mjs`。物理引擎升级 =
换 extra/ 下产物 + 重扫清单。

## 测试例

真实测试例：
- `scripts/check-runtime.mjs` —— 产物横幅/外部化一致性（build 链与手动可跑）；
- `pnpm test:regression:core` —— P0 套件群直连 public/engine 产物（harness
  `engineURL/coreURL`），产物损坏/缺失在此第一时间暴露；
- `pnpm test:all` 归档 reports/（coverage + smoke + summary + history.jsonl）。

产物相关失败排查顺序：产物是否存在 → check-runtime → smoke P0 →
web-preview-files 清单一致性（见 runtime-comm.md 已知坑）。
