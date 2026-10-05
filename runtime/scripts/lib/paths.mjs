// 构建脚本公共路径（唯一定义处）：所有 runtime/scripts/** 的目录常量从这取，
// 改产物目录只需动这一处。产物目录事实源：
// - public/engine + public/web-preview —— web 运行时（engine.mjs 产出）；
// - public/exports/wechat/runtime —— 微信渠道预构建产物（wechat.mjs 产出）。
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 项目根（本模块位于 <root>/runtime/scripts/lib/） */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** web 预览运行时（player.mjs 等，随编辑器分发） */
export const WEB_PREVIEW_DIR = path.join(ROOT, "public", "web-preview");

/** web 引擎运行时产物（src/runtime 编译 + vendor/extra，engine.mjs 产出） */
export const ENGINE_DIR = path.join(ROOT, "public", "engine");

/** 微信小游戏渠道预构建产物（wechat.mjs 产出） */
export const WECHAT_RUNTIME_DIR = path.join(ROOT, "public", "exports", "wechat", "runtime");

/** 桥接层源码（TS；wechat.mjs 以 entries/wechat.ts 为 bundle 入口） */
export const BRIDGE_DIR = path.join(ROOT, "runtime", "bridge");

/** 播放侧运行时源码（engine.mjs 的编译输入） */
export const RUNTIME_SRC = path.join(ROOT, "src", "runtime");
