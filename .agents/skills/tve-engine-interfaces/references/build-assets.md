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

校验：`verifyOutput`（内建全部产物形态断言：AUTO-GENERATED 横幅、无
`import.meta.url` 残留、无裸 three/裸说明符残留，未命中显式失败——原独立校验
脚本已并入本断言并删除）。
触发点：`pnpm build` 链第一步 + vite.config.ts `runtimeBuildPlugin()`（dev 启动全量
再生 + 源变化防抖重建）。**public/engine 不入库**，任何机器一次全量再生。

**extra/ 资产清单**（外部资产事实源，手动维护）：
- `runtime/physics-engines/`：rapier.mjs（@dimforge/rapier3d-compat 产物，wasm
  base64 内联）、jolt.mjs（wasm 内联）、ammo/ 三件套（scripts/make-ammo-esm.cjs
  生成；ammo-esm.mjs 为钩子化最终形态，ammo-wasm-b64.mjs 仅作构建期 wasm 抽取源）；
- `runtime/loaders/basis/`：basis_transcoder.js/.wasm（KTX2 转码）；
- `runtime/loaders/draco/`：draco_decoder.wasm + draco_wasm_wrapper.js
  （draco_decoder.js 由 vendor-preview-loaders.mjs 构建期从 three gltf 变体拷入
  public/engine，不入库不在 extra；微信渠道随包以此为源）。

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
解码 Worker），draco_decoder.js 不随任何渠道产物（manifest EXPORT_EXCLUDED；
仅留在本地产物目录作 JS 形态降级开关）。
**多文件 gzip 特判**：.wasm 不进 assets.gzip（Rust web 管线 binaries 分流）。

**微信渠道 Draco 解码**（2026-10-05 起主线程内联方案；2026-10-07 起解码器切
wasm 形态）：微信沙箱无 Worker 且 `globalThis.Function` 被基础库 hijack
（new Function/eval 全灭）——DRACOLoader 的「fetch 解码器文本 → Blob →
Worker」链无法存活。现行链路（wasm 腿经物理 wasm 验证过的包内路径链复活）：
- `src/runtime/runtime/loaders/draco-inline.ts` = `DracoInlineLoader`（DRACOLoader
  的结构替换件，接口面 = GLTFLoader 消费的 `preload`/`decodeDracoFile`/`dispose`；
  解码序列与 three r185 DRACOWorker 逐句对齐），胶水经桥接钩子
  `__tveLoadModule`（"tve:engine/runtime/loaders/draco/draco_wasm_wrapper.js"）
  require 包内真实模块，wasm 经 `__tveInstantiateWasmFile`
  （"engine/runtime/loaders/draco/draco_decoder.wasm"）包内路径直连
  WXWebAssembly 实例化（物理/meshopt wasm 同链；字节直传与用户目录路径均被
  基础库拒绝）——接线用 emscripten 标准 `instantiateWasm` 配置口运行期注入，
  零构建期文本改写、零 Blob/零 Worker/零 fetch/零动态求值；
- 注入路径：`runtime/loaders/compressed.ts` 检测钩子在场 → 经
  `setupCompressedGltfSupport({ dracoDecoder })` 注入（web/编辑器走 DRACOLoader
  wasm 形态不变；framework 只见 `DracoDecoderLike` 结构接口）；
- 随包供给：`runtime/scripts/wechat/draco.mjs` 把 vendor 产物
  draco_wasm_wrapper.js（58KB）+ draco_decoder.wasm（192KB，合计 245KB，比旧
  纯 JS 解码器省约 260KB）拷入微信产物目录（含工厂/配置口形态 + 禁动态求值 +
  wasm 魔数三道断言）；导出期按项目 `resources.dracoCompression` 条件随包
  （manifest 独立 `draco` 组 → runtime-supply `includeDracoDecoder` 映射，与
  web 同判据；未启用的包内无此文件），Rust `is_wechat_runtime_key` 白名单收键
  （.wasm 按后缀通判 base64 解码落盘）；preflight 不再拦 Draco（Basis 仍拦）；
- 回归守卫：`wechat/draco-smoke.mjs` 挂在微信构建链（编码器现场压缩最小网格 →
  随包 wrapper + .wasm 真字节 → DracoInlineLoader 经双钩子桩解码断言 + 三条
  负路径：坏字节/wasm 实例化失败/钩子缺席）。

## 使用例

改 src/runtime 任一源文件后：dev 下自动重建（防抖）；CI/构建走 `pnpm build`
链；手动全量再生 `node runtime/scripts/engine.mjs`。物理引擎升级 =
换 extra/ 下产物 + 重扫清单。

## 测试例

真实测试例：
- `verifyOutput`（engine.mjs 内建）—— 产物横幅/外部化一致性（每次构建自动跑）；
- `pnpm test:regression:core` —— P0 套件群直连 public/engine 产物（harness
  `engineURL/coreURL`），产物损坏/缺失在此第一时间暴露；
- `pnpm test:all` 归档 reports/（coverage + smoke + summary + history.jsonl）。

产物相关失败排查顺序：产物是否存在 → engine.mjs 重建（verifyOutput 失败即形态漂移）→ smoke P0 →
channel-runtimes 清单一致性（见 runtime-comm.md 已知坑）。
