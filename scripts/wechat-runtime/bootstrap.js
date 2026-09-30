// 微信小游戏运行时 bundle 入口。求值顺序即适配顺序（ESM import 声明顺序 =
// 模块求值顺序）：各适配模块在自身求值期完成全局安装（见各文件底部），
// engine/tve 门面随后求值，player.mjs 最后（模块体末尾自启 main()）。
// data.js 由导出期 Rust 生成（esbuild external，产物内保留运行期 require("./data.js")）。
// 主模块命名空间导出 __tveFacade（= engine/core/tve.mjs 全部导出）：
// 包内 engine/core/tve.js 转发它，用户脚本经 require 消费，不依赖跨模块全局。

import { isWechatRuntime } from "./env.js";
import "./canvas.js";
import "./codec.js";
import "./url.js";
import "./image.js";
import "./dom.js";
import "./http.js";
import "./events.js";
import "./audio.js";
import "./storage.js";
import "./load-module.js";
import "./data-bridge.js";
import * as tveApi from "../../public/engine/core/tve.mjs";
import "../../public/web-preview/player.mjs";

export const __tveFacade = tveApi;

export { isWechatRuntime };
