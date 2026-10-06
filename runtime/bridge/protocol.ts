// 运行时协议常量（单一事实源）：__tve* 全局钩子名、tve: 说明符前缀、包内
// 路径约定。生产侧（构建脚本锚点改写注入）与消费侧（桥接核心安装、引擎源
// 调用）都从这里取名——新增/改名钩子只动这一处。
//
// 消费方式（两条，均经 node/esbuild 的 TS 支持）：
// - 桥接层 TS 与构建脚本 .mjs 直接 import（node ≥22 原生类型剥离直跑 .ts，
//   check-surface.mjs 同款；esbuild bundle 按普通模块解析）；
// - src/runtime/**（引擎产物源）**不 import 本文件**：引擎产物对文本形态有
//   smoke 断言，交叉常量在引擎源保持字面量、由此处的注释登记对齐关系。
//
// 安装方全局总览（check-surface.mjs 对 window.__tve* 前缀放行的依据：
// 新钩子必须先在此登记，再进 GLOBAL_SURFACE）。

/** 用户脚本动态加载钩子：wechat.mjs 把 engine/core/scripts.mjs 的动态 import
 *  改写为本钩子；桥接 load-module.ts 安装（剥 tve: 前缀 + 小写折叠 + require） */
export const TVE_LOAD_MODULE = "__tveLoadModule";

/** 包外 wasm 文件实例化钩子：web 渠道由 wasm-fileize.mjs 把物理胶水改写为直连
 *  本钩子（src/framework/physics/wasm-file-hook.ts 与编辑器 ammoBackend 安装）；
 *  微信渠道由桥接 wasm.ts 安装（WXWebAssembly 包内路径直连）。
 *  签名：(path, imports) → Promise<{ module, instance }>，path = 产物根相对 */
export const TVE_INSTANTIATE_WASM_FILE = "__tveInstantiateWasmFile";

/** 平台 Worker 单实例多路复用钩子：微信渠道桥接 worker.ts 安装（wx.createWorker
 *  平台限额 1），runtime/channelWorker.ts 经 `__tveCreateWorker(url, protocol)` 取
 *  ns 信封端口（protocol 即 ns：physics/animation）；web 渠道不安装（保持原生
 *  module Worker 形态）。wasm 字节经保留 ns "bridge" 由主线程 readPackageFile 回传
 *  （worker 线程无文件系统/WXWebAssembly） */
export const TVE_CREATE_WORKER = "__tveCreateWorker";

/** 微信渠道 worker bundle 的包内入口（wx.createWorker 路径；导出期按项目物理后端
 *  从 workers/<backend>/tve.js 改键落盘；game.json 仅在其实际随包时声明 workers 字段） */
export const TVE_WORKER_ENTRY = "workers/tve.js";

/** worker 信封的保留 ns：ready 握手 / wasm 字节请求回传 / worker 侧日志
 *  （主线程侧 worker.ts 与 worker 侧 worker-relay.ts 共用） */
export const TVE_WORKER_NS_BRIDGE = "bridge";

/** 引擎 postLog 的 worker 转发钩子：worker 侧 worker-relay 安装，core/log 的
 *  postLog 检测在位即优先转发（worker 线程无 window，原 window.parent 通道
 *  不可达；不定义 window 全局——emscripten 环境探测会误判成 web） */
export const TVE_WORKER_LOG_HOOK = "__tveWorkerLog";

/** 微信主 bundle 的 tve 门面导出名：entries/wechat.ts 命名空间导出，
 *  包内 engine/core/tve.js 转发它供用户脚本 require */
export const TVE_FACADE = "__tveFacade";

/** 内联构建数据全局名：web 单页由 Rust inline_data_script 注入
 *  window.__TVE_BUILD_DATA；微信由 data-bridge.ts 从 data.js require 后双写 */
export const TVE_BUILD_DATA = "__TVE_BUILD_DATA";

/** 单页内联模块的裸说明符前缀：Rust specifiers.rs（INLINE_MODULE_PREFIX）把相对
 *  import 重写为 `tve:<产物内路径>`，单页引导脚本的 import map 映射到 Blob URL；
 *  微信 load-module 剥同款前缀后 require 包内键 */
export const TVE_SPEC_PREFIX = "tve:";

/** 物理引擎产物在产物根下的路径前缀（web .mjs 胶水 / 微信 CJS .js 胶水同布局；
 *  manifest.mjs 物理分组、wechat.mjs 随包产物、wasm-fileize.mjs 同目录 .wasm
 *  全部对齐这条前缀） */
export const PHYSICS_ENGINES_PREFIX = "engine/runtime/physics-engines/";

/** meshopt 解码 wasm 的包内路径（GLTFLoader 压缩模型依赖；微信随包 + 钩子加载） */
export const MESHOPT_WASM_PATH = "engine/runtime/loaders/meshopt_decoder.wasm";

/** 物理引擎产物根相对路径助手（胶水与同目录 .wasm 同主名） */
export function physicsEnginePath(file) {
  return PHYSICS_ENGINES_PREFIX + file;
}
