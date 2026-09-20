# src/runtime/extra — 手动维护的外部运行时资产（单一事实源）

本目录存放**无法从 `src/runtime/**.ts` 编译生成**的第三方运行时资产：预编译的
物理引擎构建与 wasm 解码器。目录结构与 `public/engine/` 根对齐（`extra/<rel>` →
`public/engine/<rel>`），由 `scripts/build-runtime.mjs` 的拷贝步骤在**编译前**字节级
原样拷入 `public/engine/`（内容不一致才写入）。

约定：

- **只拷贝、不编译**——这些文件不参与 esbuild/vite 转译，不会加 AUTO-GENERATED
  横幅（保持字节级原样）；`collectInputs()` / `check-runtime.mjs` 均显式跳过本目录。
- **本目录入库；`public/engine` 整个目录是纯构建产物、不入库**（见根 `.gitignore`），
  干净检出后首次 `pnpm dev` / `pnpm build` 全量再生。
- 不要直接改 `public/engine` 下的这些副本——改了也会在下次构建时被本目录覆盖
  （且下次构建不会保留：engine 内容始终由 源编译 + 本目录 + three vendor 三路决定）。

## 清单与升级方式

| 文件 | 来源 | 升级方式 |
|---|---|---|
| `runtime/physics-engines/rapier.mjs` | npm `@dimforge/rapier3d-compat`（构建产物） | 升级依赖后从 `node_modules/@dimforge/rapier3d-compat` 取构建产物手工替换 |
| `runtime/physics-engines/jolt.mjs` | 上游 JoltPhysics.js 官方 wasm 内联构建 | 从官方发行版手工替换 |
| `runtime/physics-engines/ammo/{ammo-esm.mjs, ammo-glue.mjs, ammo-wasm-b64.mjs}` | kripken/ammo.js（zlib License） | 把上游 `ammo.wasm.js` + `ammo.wasm.wasm` 放入本目录，跑 `node scripts/make-ammo-esm.cjs`（脚本会生成三件套并删除原始文件） |
| `runtime/loaders/basis/{basis_transcoder.js, basis_transcoder.wasm}` | three `examples/jsm/libs/basis/` | 升级 three 后从 node_modules 手工替换 |
| `runtime/loaders/draco/{draco_wasm_wrapper.js, draco_decoder.wasm}` | three `examples/jsm/libs/draco/gltf/` | 同上（`draco_decoder.js` 不在此列——它由 `scripts/vendor-preview-loaders.mjs` 生成并入库） |

这些资产在导出链路中的角色见 `scripts/gen-web-preview-files.mjs`（清单与
导出包含/排除特判）与 `src-tauri/src/build.rs`（`engine/runtime/loaders/draco|basis/`
识别为运行时支持数据）。
