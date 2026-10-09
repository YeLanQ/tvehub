// 桥接核心 · 音频解码兜底：部分真机 decodeAudioData 既不调 success 也不调 error
//（不回调型静默失败，社区实证），引擎 loadBuffer 的 Promise 会永挂 → 音源静音。
// 壳的语义：每次尝试传输入的副本（原生可能 detach 输入缓冲，副本保重试可用）、
// 超时判定（native.__tveDecodeTimeoutMs 可覆盖，缺省 10s）、重试一次、失败经
// bridgeLog 可见化（debug 构建 / 模拟器可读）。回调与 Promise 双形态兼容。

import { bridgeLog } from "./log.ts";
import type { AudioDiagCounters } from "./audio-diag.ts";
import type { NativeAudioContext } from "./audio.ts";

const DEFAULT_TIMEOUT_MS = 10000;
const RETRIES = 2; // 首发 + 重试一次

/** 解码壳形态：回调形态返回 undefined，Promise 形态返回 thenable（three 兼容） */
export type DecodeShim = (
  audioData: ArrayBuffer,
  success?: (buffer: unknown) => void,
  error?: (error: unknown) => void,
) => Promise<unknown> | undefined;

export function createDecodeShim(
  native: NativeAudioContext,
  counters: Pick<AudioDiagCounters, "decodeOk" | "decodeFail" | "decodeTimeout" | "lastDuration">,
): DecodeShim {
  const timeoutMs = (): number => {
    const v = native.__tveDecodeTimeoutMs;
    if (typeof v === "number" && v > 0) return v;
    return DEFAULT_TIMEOUT_MS;
  };

  const attempt = (
    input: ArrayBuffer,
    settle: (ok: boolean, value: unknown) => void,
    left: number,
  ): void => {
    let settled = false;
    let source: ArrayBuffer = input;
    try {
      if (typeof input.slice === "function") source = input.slice(0);
    } catch {
      /* 不可复制按原件直传 */
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      counters.decodeTimeout++;
      if (left > 1) return attempt(input, settle, left - 1);
      counters.decodeFail++;
      bridgeLog("warn", "[runtime-bridge] decodeAudioData 超时（原生未回调，已重试一次）");
      settle(false, new Error("decodeAudioData timeout"));
    }, timeoutMs());
    const ok = (buf: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      counters.decodeOk++;
      const rec = buf as { duration?: unknown } | null;
      if (rec && typeof rec.duration === "number") counters.lastDuration = rec.duration;
      settle(true, buf);
    };
    const bad = (err: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (left > 1) return attempt(input, settle, left - 1);
      counters.decodeFail++;
      bridgeLog("warn", "[runtime-bridge] decodeAudioData 失败", err);
      settle(false, err);
    };
    try {
      if (typeof native.decodeAudioData !== "function") throw new Error("平台缺 decodeAudioData");
      const r = native.decodeAudioData(source, ok, bad);
      if (r && typeof (r as { then?: unknown }).then === "function") {
        (r as Promise<unknown>).then(ok, bad);
      }
    } catch (e) {
      clearTimeout(timer);
      bad(e);
    }
  };

  return (audioData, success, error) => {
    const task = new Promise<unknown>((resolve, reject) => {
      attempt(audioData, (ok, value) => {
        if (ok) resolve(value);
        else reject(value);
      }, RETRIES);
    });
    if (typeof success === "function") {
      task.then(success, typeof error === "function" ? error : undefined);
      return undefined;
    }
    return task;
  };
}
