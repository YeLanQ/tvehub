// 桥接核心 · 平台 Worker 桥（主线程侧）：安装 __tveCreateWorker 钩子，把平台
// Worker（微信 wx.createWorker，平台限额每包 1 个）多路复用给引擎的渠道端口。
//
// 信封协议（单源常量见 ./protocol.ts）：
//   主 → worker：{ ns, seq, payload }   ns = 协议名（physics/animation/bridge）
//   worker → 主：同构信封；ns "bridge" 为保留信道（ready 握手 / wasm 字节请求 /
//   worker 侧日志），其余按 ns 派发给对应端口。
//
// 平台事实驱动的三个机制（2026-10 真机/工具实测）：
// - ready 门：wx.createWorker 返回 ≠ worker bundle 加载完成，加载窗口内的下行
//   消息被平台静默丢弃——端口发出的一切先入缓冲，收到 worker 侧 ready 再放行；
// - 拷贝归一：跨上下文 TypedArray 结构化克隆不可靠（真机子上下文静默拒收），
//   下行消息深遍历把 TypedArray 换成纯数组（worker 侧路由按索引读写兼容）；
// - 字节中继：worker 线程无文件系统/WXWebAssembly——物理 wasm 以 bridge 信道
//   请求，主线程 readPackageFile 读包后 base64 回传，worker 侧原生 WebAssembly
//   实例化（与主线程 __tveInstantiateWasmFile 钩子同名同签名，见 wasm.ts）。

import { bridgeActive, host } from "./host.ts";
import { setGlobal } from "./install.ts";
import { bridgeLog } from "./log.ts";
import { TVE_CREATE_WORKER, TVE_WORKER_ENTRY, TVE_WORKER_NS_BRIDGE } from "./protocol.ts";
import { bytesToBase64 } from "./b64.ts";

/** 平台 Worker 中性形态（= contract.ts HostWorker 的结构本视；平台层产出） */
interface HostWorkerLike {
  onMessage(cb: (msg: unknown) => void): void;
  postMessage(msg: unknown): void;
  terminate(): void;
}

/** 渠道端口（= runtime/channelWorker.ts ChannelWorkerPort 的结构本视） */
interface BridgeWorkerPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: { message?: string }) => void) | null;
  terminate(): void;
}

/** ns 信封（主 ↔ worker 双向同构） */
interface WorkerEnvelope {
  ns: string;
  seq: number;
  payload: unknown;
}

/** 当前支持多路复用的协议（worker 侧已有路由的 ns；与 entries/wechat-worker.ts
 *  的 ns 分发一一对应） */
const SUPPORTED_PROTOCOLS: ReadonlySet<string> = new Set(["physics", "animation"]);

/** ready 门超时（wx.createWorker 返回到 worker bundle 就绪的等待上限；超时按
 *  平台不支持处理——单例终结，此后 createPort 返回 null → 引擎回退主线程） */
const READY_TIMEOUT_MS = 10_000;

/** 下行缓冲上限（ready 前积压的端口消息条数；物理 init 仅 1 条，留足余量） */
const BOOT_BUFFER_LIMIT = 128;

let singleton: HostWorkerLike | null = null;
let singletonReady = false;
let bootBuffer: WorkerEnvelope[] = [];
let readyTimer: ReturnType<typeof setTimeout> | null = null;
let seqCounter = 0;
/** 活跃端口（ns → 端口记录；ns 即协议名，同协议重建 = 复用同一 worker 侧状态） */
const ports = new Map<string, BridgeWorkerPort>();

// ---------------------------------------------------------------------------
// 诊断状态（真机弹窗「W」行读出；真机控制台不中继用户代码，这里是创建→ready→
// wasm 链路的结构化读出面，配合「志」行的 [bridge] 日志分诊）
// ---------------------------------------------------------------------------

const workerDiag = { attempts: 0, ready: false, readyAtMs: 0, createdAtMs: 0, lastEvent: "未尝试" };

function noteWorkerEvent(text: string): void {
  workerDiag.lastEvent = text;
}

/** 诊断弹窗读出：创建/ready 态 + 里程碑时刻 + 最后事件（一行） */
export function workerDiagLine(): string {
  const t = (ms: number): string => (ms ? `${((ms - workerDiag.createdAtMs) / 1000).toFixed(1)}s` : "-");
  return `创${workerDiag.attempts > 0 ? 1 : 0} 就绪${workerDiag.ready ? 1 : 0} 创建${t(workerDiag.createdAtMs)} 就绪@${t(workerDiag.readyAtMs)} 末事=${workerDiag.lastEvent}`;
}

// ---------------------------------------------------------------------------
// 下行：信封发送与拷贝归一
// ---------------------------------------------------------------------------

/** TypedArray 判定（结构化克隆不可靠的形态；DataView 不在消息协议中使用） */
function isTypedArrayLike(v: unknown): v is { length: number; [k: number]: number } {
  return (
    typeof v === "object" &&
    v !== null &&
    ArrayBuffer.isView(v) &&
    !(v instanceof ArrayBuffer) &&
    typeof (v as { length?: unknown }).length === "number"
  );
}

/** 深遍历把 TypedArray 换成纯数组（拷贝语义传输的归一；其余结构原样保留） */
function plainify(value: unknown, depth: number): unknown {
  if (depth <= 0) return value;
  if (isTypedArrayLike(value)) return Array.from(value as ArrayLike<number>) as unknown;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = plainify(item, depth - 1);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (typeof value === "object" && value !== null) {
    let changed = false;
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src)) {
      const next = plainify(src[key], depth - 1);
      if (next !== src[key]) changed = true;
      out[key] = next;
    }
    return changed ? out : value;
  }
  return value;
}

/** 经单例发送；单例缺席/平台抛错返回 false（调用方静默丢弃，引擎侧有忙位/超时兜底） */
function postToWorker(env: WorkerEnvelope): boolean {
  const w = singleton;
  if (!w) return false;
  try {
    w.postMessage(env);
    return true;
  } catch (e) {
    bridgeLog("warn", "[runtime-bridge] worker 下行发送失败（按消息丢弃）", e);
    return false;
  }
}

/** ready 门：就绪直发，未就绪入缓冲（超上限丢最旧并告警） */
function sendOrBuffer(env: WorkerEnvelope): void {
  if (singletonReady) {
    postToWorker(env);
    return;
  }
  if (bootBuffer.length >= BOOT_BUFFER_LIMIT) {
    bootBuffer.shift();
    bridgeLog("warn", "[runtime-bridge] worker ready 前下行积压超限，丢弃最旧一条");
  }
  bootBuffer.push(env);
}

function flushBootBuffer(): void {
  const queued = bootBuffer;
  bootBuffer = [];
  if (queued.length) {
    bridgeLog("log", `[runtime-bridge] worker 已就绪，放行缓冲下行 ${queued.length} 条`);
  }
  for (const env of queued) postToWorker(env);
  // 下行活性探针：worker 收到后回 pong（真机/工具投递形态差异的常驻判据，
  // 每次 worker 建立仅一条）
  setTimeout(() => {
    postToWorker({ ns: TVE_WORKER_NS_BRIDGE, seq: ++seqCounter, payload: { t: "ping" } });
  }, 1500);
}

// ---------------------------------------------------------------------------
// 上行：信封解包与派发
// ---------------------------------------------------------------------------

/** 信封解包：兼容消息本体直投与 {data} 包装（平台两形态，工具与真机不一） */
function unwrapEnvelope(raw: unknown): WorkerEnvelope | null {
  const candidates: unknown[] = [raw];
  if (typeof raw === "object" && raw !== null && "data" in raw) {
    candidates.push((raw as { data?: unknown }).data);
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

/** bridge 保留信道载荷（ready/wasmReq/log 的联合窄化视图） */
interface BridgePayload {
  t?: unknown;
  id?: unknown;
  path?: unknown;
  text?: unknown;
}

function handleBridgePayload(payload: unknown): void {
  const p = (typeof payload === "object" && payload !== null ? payload : {}) as BridgePayload;
  if (p.t === "ready") {
    if (readyTimer !== null) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
    singletonReady = true;
    workerDiag.ready = true;
    workerDiag.readyAtMs = Date.now();
    noteWorkerEvent("ready（bundle 加载完成）");
    bridgeLog("log", "[runtime-bridge] worker 已就绪（worker bundle 加载完成）");
    flushBootBuffer();
    return;
  }
  if (p.t === "wasmReq" && typeof p.id === "number" && typeof p.path === "string") {
    noteWorkerEvent(`wasm字节请求 ${p.path.slice(-40)}`);
    bridgeLog("log", `[runtime-bridge] worker wasm 字节请求: ${p.path}`);
    let b64: string | null = null;
    try {
      const bytes = host()?.readPackageFile(p.path);
      b64 = bytes ? bytesToBase64(bytes) : null;
    } catch (e) {
      bridgeLog("warn", `[runtime-bridge] worker wasm 字节读取失败: ${p.path}`, e);
      b64 = null;
    }
    sendOrBuffer({ ns: "bridge", seq: ++seqCounter, payload: { t: "wasmRes", id: p.id, b64 } });
    return;
  }
  if (p.t === "log" && typeof p.text === "string") {
    bridgeLog("log", `[tve-worker] ${p.text}`);
  }
}

function handleWorkerMessage(raw: unknown): void {
  const env = unwrapEnvelope(raw);
  if (!env) return; // 非信封形态（平台杂音）按忽略
  if (env.ns === TVE_WORKER_NS_BRIDGE) {
    handleBridgePayload(env.payload);
    return;
  }
  const port = ports.get(env.ns);
  if (!port) return;
  try {
    port.onmessage?.({ data: env.payload });
  } catch (e) {
    bridgeLog("warn", `[runtime-bridge] worker 消息派发异常（ns=${env.ns}）`, e);
  }
}

// ---------------------------------------------------------------------------
// 单例与端口生命周期
// ---------------------------------------------------------------------------

function clearReadyTimer(): void {
  if (readyTimer !== null) {
    clearTimeout(readyTimer);
    readyTimer = null;
  }
}

/** 终结单例（最后一次 terminate / ready 超时；此后 createPort 返回 null → 主线程回退） */
function terminateSingleton(): void {
  clearReadyTimer();
  const w = singleton;
  singleton = null;
  singletonReady = false;
  bootBuffer = [];
  noteWorkerEvent(w && !workerDiag.ready ? "ready超时→终结回退" : "已终结");
  if (w) {
    try {
      w.terminate();
    } catch {
      /* 平台已自灭按终止 */
    }
  }
}

/** 构建配置的多线程开关（data.js config.workerThread，导出期按面板勾选写入：
 *  worker bundle 实际随包时为 true）。缺省（旧产物/配置缺失）按 true 处理——
 *  尝试创建失败有回退兜底；显式 false = 包内无 worker bundle，静默回主线程
 *  且不触达 wx.createWorker（缺失文件的平台报错行从根上消除）。 */
function workerThreadEnabled(): boolean {
  try {
    const data = (globalThis as { __TVE_BUILD_DATA?: { config?: { workerThread?: unknown } } })
      .__TVE_BUILD_DATA;
    return data?.config?.workerThread !== false;
  } catch {
    return true;
  }
}

function createPort(protocol: string): BridgeWorkerPort | null {
  if (!SUPPORTED_PROTOCOLS.has(protocol)) return null;
  if (!workerThreadEnabled()) {
    noteWorkerEvent("多线程未勾选（全主线程）");
    return null;
  }
  const endpoint = host();
  if (!endpoint || typeof endpoint.createWorker !== "function") {
    noteWorkerEvent("端点缺席（钩子未装/平台无 createWorker）");
    return null;
  }
  if (!singleton) {
    let w: HostWorkerLike | null = null;
    try {
      w = endpoint.createWorker(TVE_WORKER_ENTRY);
    } catch (e) {
      noteWorkerEvent(`创建抛错 ${e instanceof Error ? e.message.slice(0, 60) : String(e).slice(0, 60)}`);
      bridgeLog("warn", "[runtime-bridge] 平台 createWorker 抛错（回退主线程）", e);
      w = null;
    }
    if (!w) return null;
    singleton = w;
    singletonReady = false;
    bootBuffer = [];
    workerDiag.attempts = 1;
    workerDiag.ready = false;
    workerDiag.createdAtMs = Date.now();
    noteWorkerEvent("已创建，等 ready");
    w.onMessage(handleWorkerMessage);
    readyTimer = setTimeout(() => {
      if (!singletonReady) {
        noteWorkerEvent("ready超时(10s)");
        bridgeLog("warn", "[runtime-bridge] worker ready 超时，按平台不支持回退主线程");
        terminateSingleton();
      }
    }, READY_TIMEOUT_MS);
    bridgeLog("log", `[runtime-bridge] 平台 Worker 已创建（${TVE_WORKER_ENTRY}）`);
  }
  const existing = ports.get(protocol);
  if (existing) return existing; // 同协议复用既有端口（worker 侧状态即单份）
  const port: BridgeWorkerPort = {
    postMessage(message, transfer) {
      void transfer; // transfer 仅 DOM 传输支持；平台拷贝语义下经 plainify 归一复制
      sendOrBuffer({ ns: protocol, seq: ++seqCounter, payload: plainify(message, 8) });
    },
    onmessage: null,
    onerror: null,
    terminate() {
      ports.delete(protocol);
      // 最后一个端口关闭 → 终结平台 Worker（下次 createPort 重新懒建，状态全新）
      if (ports.size === 0) terminateSingleton();
    },
  };
  ports.set(protocol, port);
  return port;
}

// 安装（bootstrap 以 import 装配；见 entries/wechat.ts 求值序）
export function installCreateWorkerHook(): void {
  if (!bridgeActive()) return;
  const endpoint = host();
  if (!endpoint || typeof endpoint.createWorker !== "function") return;
  setGlobal(TVE_CREATE_WORKER, (workerUrl: string, protocol: unknown): BridgeWorkerPort | null => {
    void workerUrl; // 入口路径由桥接自持（TVE_WORKER_ENTRY）；签名与 channelWorker 对齐
    return createPort(String(protocol ?? ""));
  });
}

installCreateWorkerHook();
