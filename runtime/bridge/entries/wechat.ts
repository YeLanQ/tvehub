// 微信渠道 bundle 入口（桥接层的渠道组装点）。求值顺序即安装顺序（ESM import
// 声明顺序 = 模块求值顺序）：
//   platforms/wechat（注册 host）→ wasm（WebAssembly 垫片）→ env → canvas →
//   codec → url → image → dom → http → events → audio → storage → load-module →
//   data-bridge → engine/tve 门面 → player.mjs（模块体末尾自启 main()）
// 核心模块与平台端点的分工见 ../contract.js；新增渠道 = 平级平台端点 + 本文件的
// 对应组装副本。data.js 由导出期 Rust 生成（esbuild external，产物内保留运行期
// require("./data.js")）。
// 主模块命名空间导出 __tveFacade（= engine/core/tve.mjs 全部导出）：
// 包内 engine/core/tve.js 转发它，用户脚本经 require 消费，不依赖跨模块全局。

import "../platforms/wechat.js";
import "../wasm.js";
import "../env.js";
import "../canvas.js";
import "../codec.js";
import "../url.js";
import "../image.js";
import "../dom.js";
import "../http.js";
import "../events.js";
import "../audio.js";
import "../storage.js";
import "../load-module.js";
import "../data-bridge.js";
import * as tveApi from "../../../public/engine/core/tve.mjs";
import "../../../public/web-preview/player.mjs";

export const __tveFacade = tveApi;
