# 单元：预览/导出通信与单页内联

## 契约

**编辑器 ↔ player（iframe postMessage）**：
- 编辑器 → player：`{ __editorPreviewDebug: true, visible }`（调试面板开合，
  player.mjs:862 接收）；
- player → 编辑器：`postLog`（engine/core/log.mjs 把 console 转发回编辑器控制台，
  `setLogForwarding` 控制开关）。

**单页导出内联**：构建产物可把 config/场景/资产内联进 index.html 的
`window.__TVE_BUILD_DATA`（player.mjs:157 优先读取，缺省回落 fetch 同目录
scene.json/config.json）；bootstrap 注入 `tve:<rel>` 形式的 import map，
用户脚本以裸说明符导 Blob 模块。

**资产装载 shim**：`runtime/pak.mjs`（`installAssetShim/parseArchive/gunzip/
base64ToBytes`）+ `asset-bundle.ts` + `resource.mjs`（resourceLoader）——
gzip 归档（assets.gzip）与发布模式（uid 重命名 + 引用重写）的透明装载层；
CDN 模式下 three 运行时从远程基址加载（构建期相对说明符重写保证兼容）。

**文本读取通道**（编辑器侧）：`src/app/lib/web-preview-runtime.ts` 的
`fetchWebPreviewRuntimeTexts(opts)` —— 清单来自 `src/generated/
web-preview-files.ts`（自动扫描生成，勿手改）；物理按后端、WebGPU/Draco/Basis
按项目开关条件包含。四种导出模式与局域网共享复用同一文本集。

## 使用例

`src/app/components/WebPreviewPanel.vue`（iframe 加载预览 URL + 调试面板
postMessage 切换）；`src/app/lib/build-export.ts:271`（buildExport 时把运行时
文本集随 files 提交后端）。

## 测试例

真实测试例：
- `scripts/smoke/tracker/smoke-pak-runtime.mjs` 类套件覆盖归档装载（P0 面）；
- smoke harness 的 `installDomShim()`（scripts/smoke/harness.mjs:40 起）——node 下
  跑导入期访问 window/document 的运行时模块，缺更多桩（canvas/baseURI）时调用后自行补。

**已知坑**：产物被 SPA 兜底成 200+HTML 会以 blob 模块语法错误的形式爆发
（文件缺失 / 存在但不在 web-preview-files 快照内两种根因）——预览白屏先核对
清单与产物一致性，再查 `check-runtime.mjs` 校验（AUTO-GENERATED 横幅、无裸 three 残留）。
