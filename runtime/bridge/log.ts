// 桥接层日志门控：与 player 的 setLogForwarding 同一口径——release 构建
// （config.debug !== true）零 console 输出。门控事实源 = data-bridge 装配的
// window.__TVE_BUILD_DATA.config.debug；桥接安装期的日志（如 wasm 垫片安装）
// 早于 data-bridge 求值，先进缓冲，data-bridge 装配后 flushBridgeLogs 按门控
// 回放。配置缺失/形态异常一律按 release 处理（宁缺勿噪）。

import { captureLine } from "./log-capture.ts";

/** 日志级别（console 同名方法直调） */
type BridgeLogLevel = "log" | "warn" | "error";

/** null = 门控未知（缓冲）；true = debug 放行；false = release 静默 */
let gate: boolean | null = null;
const pending: Array<[BridgeLogLevel, unknown[]]> = [];

function emit(level: BridgeLogLevel, args: unknown[]): void {
  try {
    console[level](...args);
  } catch {
    /* console 缺失环境静默 */
  }
}

function resolveGate(): void {
  try {
    const data = (globalThis as unknown as { __TVE_BUILD_DATA?: { config?: { debug?: unknown } } })
      .__TVE_BUILD_DATA;
    gate = data?.config?.debug === true;
  } catch {
    gate = false;
  }
}

/**
 * 桥接层受控日志（level: "log" | "warn" | "error"）。门控未知时进缓冲。
 * 消息前缀由调用方自带（[runtime-bridge] / [tve]）。
 * 全量镜像进诊断环（log-capture）：真机控制台不中继用户代码 console，诊断弹窗
 * 的「志」行是 worker 创建/ready/wasm 链路日志的唯一真机读出口（弹窗自身有
 * __tveDiagOn 显式开关）；console 发射仍按 debug 门控。
 */
export function bridgeLog(level: BridgeLogLevel, ...args: unknown[]): void {
  try {
    captureLine(level, "[bridge] " + args.map((a) => String(a)).join(" "));
  } catch {
    /* 环缺席静默（log-capture 未装载的极端时序） */
  }
  if (gate === null) {
    pending.push([level, args]);
    return;
  }
  if (gate) emit(level, args);
}

/** data-bridge 装配 __TVE_BUILD_DATA 后调用：定门控并回放缓冲 */
export function flushBridgeLogs(): void {
  resolveGate();
  for (const [level, args] of pending.splice(0)) {
    if (gate) emit(level, args);
  }
}
