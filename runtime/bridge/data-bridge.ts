// 桥接核心 · 构建数据桥：./data.js 为导出期生成的 CJS 模块（esbuild 标记 external，
// 产物中保留运行期 require）。数据注入 window/globalThis 双写——player 的 main()
// 与 scripts.ts 的内联判定都从这里读取，零文件系统参与。

import { bridgeActive } from "./host.ts";
import { setGlobal, windowRef } from "./install.ts";
import { bridgeLog, flushBridgeLogs } from "./log.ts";

import * as tveBuildData from "./data.js";

export function installBuildData() {
  if (!bridgeActive()) return;
  const data = tveBuildData && (tveBuildData.default ?? tveBuildData);
  if (!data || typeof data !== "object") {
    bridgeLog("error", "[runtime-bridge] data.js 形态异常（缺少 config/assets）");
    flushBridgeLogs();
    return;
  }
  setGlobal("__TVE_BUILD_DATA", data);
  try {
    const w = windowRef.current;
    if (w) w.__TVE_BUILD_DATA = data;
  } catch {
    /* window 未就绪时忽略 */
  }
  // 门控事实源已就位：定 release/debug 口径并回放安装期缓冲日志
  flushBridgeLogs();
}

// 求值期安装（bootstrap 以 import 装配，见该文件说明）
installBuildData();
