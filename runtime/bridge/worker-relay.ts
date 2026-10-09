// 桥接层 · worker 侧中继（打包进 workers/<backend>/tve.js，运行于平台 worker 线程）：
// - 信封收发：上行单通道（平台 worker 全局优先，self.postMessage 兜底）；下行双通道
//   注册（worker.onMessage + self.onmessage——工具与真机的投递目标不一）+ seq 水位
//   去重（双通道重复投递会让物理双倍速）；
// - wasm 字节中继：安装 __tveInstantiateWasmFile（与主线程 wasm.ts 同名同签名），
//   经 bridge 保留信道请求主线程 readPackageFile 读包，worker 侧原生 WebAssembly
//   实例化（真机 worker 线程无 FileSystemManager/WXWebAssembly，devtools 实测原生
//   WebAssembly 可用）。安装必须先于 physics.ts 顶层求值（入口以 import 序保证，
//   见 entries/wechat-worker.ts——wasm-file-hook 幂等让位先行安装方）。

import { base64ToBytes } from "./b64.ts";
import { TVE_WORKER_LOG_HOOK, TVE_WORKER_NS_BRIDGE } from "./protocol.ts";

/** wx worker 线程注入的平台全局（真机/工具均提供；node 冒烟经包装形参供给） */
interface WxWorkerGlobal {
  postMessage(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): void;
}

/** 上行发送函数（单通道；返回 false = 无可用通道，调用方按静默丢弃） */
export type PostMain = (ns: string, payload: unknown) => void;

/** 主 → worker 信封（与主线程侧 worker.ts 同构） */
interface WorkerEnvelope {
  ns: string;
  seq: number;
  payload: unknown;
}

/** 读平台 worker 全局（free 标识符：真机/工具注入；node 冒烟由包装形参遮蔽供给） */
function resolveWorkerGlobal(): WxWorkerGlobal | null {
  try {
    if (typeof worker !== "undefined" && worker && typeof worker.postMessage === "function") {
      return worker;
    }
  } catch {
    /* 沙箱遮蔽时读 free 标识符可能抛错 */
  }
  return null;
}

/** 读 DOM 风格 self（开发者工具 worker 线程实测存在：onmessage/postMessage/
 *  addEventListener 全套；下行投递走 message 事件，上行 postMessage 直发） */
function resolveSelfLike(): {
  postMessage(msg: unknown): void;
  addEventListener?(type: string, cb: (ev: { data?: unknown }) => void): void;
} | null {
  try {
    if (typeof self !== "undefined" && self) {
      const s = self as unknown as { postMessage?: unknown; addEventListener?: unknown };
      if (typeof s.postMessage === "function") {
        return {
          postMessage: (msg) => (s.postMessage as (m: unknown) => void)(msg),
          addEventListener:
            typeof s.addEventListener === "function"
              ? (t, cb) => (s.addEventListener as (t: string, cb: (ev: { data?: unknown }) => void) => void)(t, cb)
              : undefined,
        };
      }
    }
  } catch {
    /* 同上 */
  }
  return null;
}

let outSeq = 0;

/** 上行通道（惰性解析；平台 worker 全局优先，self 兜底） */
let outbound: PostMain | null = null;

function resolveOutbound(): PostMain | null {
  if (outbound) return outbound;
  const w = resolveWorkerGlobal();
  if (w) {
    outbound = (ns, payload) => {
      w.postMessage({ ns, seq: ++outSeq, payload });
    };
    return outbound;
  }
  const s = resolveSelfLike();
  if (s) {
    outbound = (ns, payload) => {
      s.postMessage({ ns, seq: ++outSeq, payload });
    };
    return outbound;
  }
  return null;
}

/** 上行发送（ns + payload；无通道时静默丢弃——引擎侧有忙位/超时兜底） */
export function postMain(ns: string, payload: unknown): void {
  const send = resolveOutbound();
  if (!send) return;
  send(ns, payload);
}

/** 下行信封解包：平台投递形态层层包裹（实测三形态，工具与真机不一）——
 *  消息本体直投 / {data:信封} / 事件 {msg:{data:信封}}（开发者工具 self.message
 *  事件带平台包装）/ {data:{message:信封}}。逐层下降找 ns+seq，超出即未知形态。 */
function unwrapEnvelope(raw: unknown): WorkerEnvelope | null {
  const candidates: unknown[] = [raw];
  if (typeof raw === "object" && raw !== null) {
    const r = raw as Record<string, unknown>;
    candidates.push(r.data, r.msg, (r.data as Record<string, unknown> | undefined)?.message, (r.msg as Record<string, unknown> | undefined)?.data);
  }
  for (const c of candidates) {
    if (typeof c !== "object" || c === null) continue;
    const env = c as Partial<WorkerEnvelope>;
    if (typeof env.ns === "string" && typeof env.seq === "number") {
      return { ns: env.ns, seq: env.seq, payload: env.payload };
    }
  }
  return null;
}

/** 下行处理器（入口注入：bridge 信道 → 字节中继；协议 ns → 引擎路由） */
export type MainMessageHandler = (ns: string, payload: unknown, seq: number) => void;

/**
 * 注册下行双通道（worker.onMessage + self message 事件）+ seq 水位去重。
 * 平台投递形态实测（2026-10-06 工具/真机）：开发者工具走 self 的 DOM message
 * 事件（且只调 addEventListener 监听器、不调 onmessage 属性；消息外还包一层
 * 平台信封，见 unwrapEnvelope）；wx 规范形态走 worker.onMessage——双注册双投
 * 由水位保证至多一次。
 */
export function receiveFromMain(handler: MainMessageHandler): void {
  let lastSeq = 0;
  let warnedUnknown = false;
  let announcedFirst = false;
  const deliver = (raw: unknown): void => {
    if (!announcedFirst) {
      announcedFirst = true;
      // 首条下行到达即回执（真机/工具下行投递目标不一，此行证明通道打通）
      postMain(TVE_WORKER_NS_BRIDGE, { t: "log", text: "下行通道已打通（收到首条下行）" });
    }
    const env = unwrapEnvelope(raw);
    if (!env) {
      if (!warnedUnknown) {
        warnedUnknown = true;
        const shape = (() => {
          try {
            return JSON.stringify(raw)?.slice(0, 120) ?? String(raw);
          } catch {
            return String(raw);
          }
        })();
        try {
          console.warn(`[tve-worker] 收到非信封下行（已忽略）: ${shape}`);
        } catch {
          /* console 缺失静默 */
        }
        postMain(TVE_WORKER_NS_BRIDGE, { t: "log", text: `收到非信封下行（已忽略）: ${shape}` });
      }
      return;
    }
    if (env.seq <= lastSeq) return; // 双通道重复投递去重（单调水位）
    lastSeq = env.seq;
    handler(env.ns, env.payload, env.seq);
  };
  const w = resolveWorkerGlobal();
  if (w && typeof w.onMessage === "function") {
    try {
      w.onMessage(deliver);
    } catch (e) {
      console.warn("[tve-worker] worker.onMessage 注册失败", e);
    }
  }
  // DOM 风格投递（开发者工具实测路径）：平台只调 addEventListener 监听器，
  // onmessage 属性不触发——必须走事件注册；事件实参 = MessageEvent，取 .data
  const s = resolveSelfLike();
  if (s && typeof s.addEventListener === "function") {
    try {
      s.addEventListener("message", (ev: { data?: unknown }) => deliver(ev?.data));
    } catch (e) {
      console.warn("[tve-worker] self message 事件注册失败", e);
    }
  }
}

// ---------------------------------------------------------------------------
// wasm 字节中继（bridge 保留信道）
// ---------------------------------------------------------------------------

let wasmReqSeq = 0;
const pendingWasm = new Map<number, (b64: string | null) => void>();

/** ammo 胶水的 node require 死代码桩（engines.mjs transformAmmoGlue 把
 *  `require("fs"/"path")` 改名为本标识符防 esbuild 误打包；胶水打包进 worker
 *  bundle 后该分支永不执行，但求值期需要标识符存在——提前注册）。 */
function installDeadRequireStub(): void {
  const g = globalThis as { __tveDeadRequire?: (mod: string) => never };
  if (typeof g.__tveDeadRequire === "function") return;
  g.__tveDeadRequire = (mod: string): never => {
    throw new Error(`[tve-worker] node 模块不可用: ${mod}（死代码分支被意外执行）`);
  };
}

/**
 * 安装 __tveInstantiateWasmFile（幂等；签名 = (path, imports) → Promise<{module, instance}>，
 * path 为包内相对路径——与 web 渠道 wasm-file-hook、微信主线程 wasm.ts 同一契约）。
 */
export function installWasmRelay(): void {
  installDeadRequireStub();
  const g = globalThis as { __tveInstantiateWasmFile?: unknown };
  if (typeof g.__tveInstantiateWasmFile === "function") return;
  g.__tveInstantiateWasmFile = (path: unknown, imports: unknown): Promise<unknown> => {
    // 钩子被调即留痕（真机/工具定位「胶水求值→钩子」断链；每次引擎加载一条）
    postMain(TVE_WORKER_NS_BRIDGE, { t: "log", text: `wasm 钩子被调用: ${String(path)}` });
    return new Promise((resolve, reject) => {
      if (typeof path !== "string") {
        reject(new Error("[tve-worker] wasm 路径形态非法"));
        return;
      }
      if (typeof WebAssembly !== "object" || typeof WebAssembly.instantiate !== "function") {
        reject(new Error("[tve-worker] worker 线程缺 WebAssembly（无法实例化物理引擎）"));
        return;
      }
      const instantiate = WebAssembly.instantiate;
      const id = ++wasmReqSeq;
      pendingWasm.set(id, (b64) => {
        if (!b64) {
          reject(new Error(`[tve-worker] wasm 字节回传为空: ${path}`));
          return;
        }
        try {
          resolve(instantiate(base64ToBytes(b64), imports as Parameters<typeof WebAssembly.instantiate>[1]));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
      postMain(TVE_WORKER_NS_BRIDGE, { t: "wasmReq", id, path });
    });
  };
}

/** bridge 信道载荷分发（wasmRes → 字节中继等待者） */
export function handleBridgePayload(payload: unknown): void {
  const p = (typeof payload === "object" && payload !== null ? payload : {}) as {
    t?: unknown;
    id?: unknown;
    b64?: unknown;
  };
  if (p.t === "wasmRes" && typeof p.id === "number") {
    const settle = pendingWasm.get(p.id);
    if (settle) {
      pendingWasm.delete(p.id);
      settle(typeof p.b64 === "string" ? p.b64 : null);
    }
    return;
  }
  if (p.t === "ping") {
    // 主线程下行活性探针：回 pong 证明双向通路（诊断日志，常驻低频）
    postMain(TVE_WORKER_NS_BRIDGE, { t: "log", text: "pong（下行探针回执）" });
  }
}

/**
 * 安装引擎 postLog 转发钩子（真机诊断可见性）：core/log 的 postLog 检测钩子在
 * 位即优先转发——物理核日志（世界就绪/引擎加载失败/Worker 内部错误）经 bridge
 * 保留信道回主线程 console。幂等；不定义 window 全局（emscripten 环境探测会把
 * worker 误判成 web 走 fetch 分支）。
 */
export function installPostLogForwarder(): void {
  const g = globalThis as { [TVE_WORKER_LOG_HOOK]?: unknown };
  if (typeof g[TVE_WORKER_LOG_HOOK] === "function") return;
  g[TVE_WORKER_LOG_HOOK] = (level: unknown, text: unknown): void => {
    const message = String(text ?? "");
    postMain(TVE_WORKER_NS_BRIDGE, {
      t: "log",
      text: level === "error" ? `[error] ${message}` : message,
    });
  };
}

// 求值期安装（入口以 import 序把本模块排在 physics 路由之前——wasm 中继钩子必须
// 先于 physics.ts 顶层求值期的 wasm-file-hook 安装，否则 fetch 版钩子占位、字节
// 中继幂等让位，worker 内 fetch 包内 wasm 304 失败且 Promise 无 catch 静默挂死）
installWasmRelay();
installPostLogForwarder();
