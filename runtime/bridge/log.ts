// 桥接层日志门控：与 player 的 setLogForwarding 同一口径——release 构建
// （config.debug !== true）零 console 输出。门控事实源 = data-bridge 装配的
// window.__TVE_BUILD_DATA.config.debug；桥接安装期的日志（如 wasm 垫片安装）
// 早于 data-bridge 求值，先进缓冲，data-bridge 装配后 flushBridgeLogs 按门控
// 回放。配置缺失/形态异常一律按 release 处理（宁缺勿噪）。

/** null = 门控未知（缓冲）；true = debug 放行；false = release 静默 */
let gate = null;
const pending = [];

function emit(level, args) {
  try {
    console[level](...args);
  } catch {
    /* console 缺失环境静默 */
  }
}

function resolveGate() {
  try {
    gate = globalThis.__TVE_BUILD_DATA?.config?.debug === true;
  } catch {
    gate = false;
  }
}

/**
 * 桥接层受控日志（level: "log" | "warn" | "error"）。门控未知时进缓冲。
 * 消息前缀由调用方自带（[runtime-bridge] / [tve]）。
 */
export function bridgeLog(level, ...args) {
  if (gate === null) {
    pending.push([level, args]);
    return;
  }
  if (gate) emit(level, args);
}

/** data-bridge 装配 __TVE_BUILD_DATA 后调用：定门控并回放缓冲 */
export function flushBridgeLogs() {
  resolveGate();
  for (const [level, args] of pending.splice(0)) {
    if (gate) emit(level, args);
  }
}
