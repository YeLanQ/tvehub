// 桥接核心 · 音频诊断：真机排障读出面（**默认恒关——debug 构建也不自动弹**，
// 用户要求；需要真机读数时显式开开关：平台 storage 盒 __tve_wx_local_storage__
// 内写 __tveDiagOn:"1"，即 wx.setStorageSync("__tve_wx_local_storage__",
// { ...原盒, __tveDiagOn: "1" })）。开启后 8s/20s 各采样弹窗一次 + 首次手势后
// 1.5s 采样弹窗一次。展示通道 = 端点非契约方法 showDiagModal（wx.showModal
// 只在平台端点可达；mock/其他端点缺席时整体静默）。定时器均 unref 化——node
// 冒烟进程不被诊断计时器拖住退出。

import { host } from "./host.ts";
import type { NativeAudioContext } from "./audio.ts";
import { touchDiag } from "./events.ts";
import { canvasEvents } from "./canvas.ts";
import { view, winEvents } from "./env.ts";
import { logTail } from "./log-capture.ts";
import { loadTelemetry } from "./load-module.ts";
import { workerDiagLine } from "./worker.ts";

/** 引擎输入探针（entries/wechat 求值后装配：读 engine.input 触点快照）。
 *  桥派发计数照涨而探针恒 0 = canvas 监听面死（注册被原生画布监听表吸走
 *  类分叉）；探针 >0 而摇杆仍死 = 命中测试/目标绑定侧问题，下一轮下钻。 */
let inputProbe: (() => string) | null = null;

export function setInputProbe(fn: () => string): void {
  inputProbe = fn;
}

function probeInput(): string {
  try {
    return inputProbe ? inputProbe() : "未装配";
  } catch {
    return "探针异常";
  }
}

/** WebAudio 侧计数（createAudioDiag 持有；decode 壳经引用写入） */
export interface AudioDiagCounters {
  decodeOk: number;
  decodeFail: number;
  decodeTimeout: number;
  gestureResume: number;
  lastDuration: number;
  gestureStates: string;
}

/** 平台代管音频计数（audio-inner 写入；模块级单例——发射器钩子独立于 ctx 生命周期） */
export const innerCounters: { innerMade: number; innerPlay: number } = { innerMade: 0, innerPlay: 0 };

/** 音频诊断面（挂门面 __tveAudioDiag 键，installAudioGlobals 消费） */
export interface AudioDiag {
  counters: AudioDiagCounters;
  /** 每次手势直调 resume 时计数；前 3 次采样原生 state（解锁时序证据） */
  noteGesture(): void;
  /** 8s/20s 定时采样弹窗（debug 构建才动作） */
  schedule(): void;
}

export function createAudioDiag(native: NativeAudioContext, createdAt: number): AudioDiag {
  const counters: AudioDiagCounters = {
    decodeOk: 0,
    decodeFail: 0,
    decodeTimeout: 0,
    gestureResume: 0,
    lastDuration: -1,
    gestureStates: "",
  };

  const read = <T,>(fn: () => T, fb: T): T => {
    try {
      return fn();
    } catch {
      return fb;
    }
  };

  const lazyTimer = (fn: () => void, ms: number): void => {
    const t = setTimeout(fn, ms) as unknown as { unref?: () => void };
    try {
      if (t && typeof t.unref === "function") t.unref();
    } catch {
      /* 非 node 环境无 unref */
    }
  };

  const show = (tag: string): void => {
    try {
      // 显式开关门控（storageGet 读平台盒中盒；默认/缺开关一律不弹）
      const endpoint = host();
      if (!endpoint || endpoint.storageGet("__tveDiagOn") !== "1") return;
      const diag = endpoint as (typeof endpoint & { showDiagModal?: (text: string) => void });
      if (typeof diag.showDiagModal !== "function") return;
      const t = ((Date.now() - createdAt) / 1000).toFixed(1);
      const state = read(() => String(native.state), "ERR");
      const cur = read(() => native.currentTime, "ERR" as unknown);
      const dur = counters.lastDuration >= 0 ? `${counters.lastDuration.toFixed(1)}s` : "-";
      diag.showDiagModal(
        `音频${tag} t=${t}s\n` +
          `state=${state} cur=${typeof cur === "number" ? cur.toFixed(2) : String(cur)}\n` +
          `解码 成${counters.decodeOk} 败${counters.decodeFail} 超时${counters.decodeTimeout}\n` +
          `时长${dur} 手势r=${counters.gestureResume} 内音${innerCounters.innerMade}/${innerCounters.innerPlay}\n` +
          (counters.gestureStates ? `手势态 ${counters.gestureStates}\n` : "") +
          `触 d${touchDiag.down} m${touchDiag.move} u${touchDiag.up} c${touchDiag.cancel} @${touchDiag.lastX},${touchDiag.lastY}\n` +
          `面 c${canvasEvents.listenerCount("pointerdown")}+${canvasEvents.listenerCount("pointermove")} w${winEvents.listenerCount("pointerdown")} 视${view.width}x${view.height}\n` +
          `探 ${probeInput()}\n` +
          `W ${read(() => workerDiagLine(), "读出异常")}\n` +
          `志${loadTelemetry.calls}/${loadTelemetry.fails} ${loadTelemetry.lastSpec.slice(-34)}${loadTelemetry.lastErr ? ` !${loadTelemetry.lastErr.slice(0, 60)}` : ""} ${logTail()}`,
      );
    } catch {
      /* 诊断失败静默 */
    }
  };

  const noteGesture = (): void => {
    counters.gestureResume++;
    if (counters.gestureResume <= 3) {
      const st = read(() => String(native.state), "?");
      counters.gestureStates = counters.gestureStates ? `${counters.gestureStates},${st}` : st;
    }
    if (counters.gestureResume === 1) lazyTimer(() => show("首触"), 1500);
  };

  const schedule = (): void => {
    lazyTimer(() => show("8s"), 8000);
    lazyTimer(() => show("20s"), 20000);
  };

  return { counters, noteGesture, schedule };
}
