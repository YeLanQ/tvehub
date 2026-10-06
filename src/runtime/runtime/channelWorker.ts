// 渠道 Worker 抽象（产物 engine/runtime/channelWorker.mjs；单一创建入口）：
// - web 渠道：原生 module Worker（workerUrl 由 player 按 import.meta.url 解析；
//   单页内联/file:// 下 URL 为空 → 返回 null，调用方回退主线程实现）；
// - 微信等平台渠道：桥接层安装 __tveCreateWorker 钩子（wx.createWorker 平台限额
//   单实例，经 ns 信封多路复用；安装方与信封协议见 runtime/bridge/worker.ts），
//   钩子在位时优先走钩子——此时 workerUrl 可为空（平台入口路径由桥接层自持）。
//   钩子对未支持的平台协议（如 worker 侧尚无路由）返回 null → 同样回退主线程。
//
// 端口形态刻意对齐 DOM Worker 的最小消费面（postMessage/onmessage/onerror/
// terminate），主线程适配层（physics.ts createPhysicsWorker 等）对两种形态无感。

/** 渠道 Worker 端口（DOM Worker 与平台桥接 Worker 的公共最小面） */
export interface ChannelWorkerPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: { message?: string }) => void) | null;
  terminate(): void;
}

/** Worker 承载的协议名（= 平台单实例 Worker 的 ns 复用键；worker 侧按 ns 路由） */
export type ChannelWorkerProtocol = "physics" | "animation";

/** 平台桥接钩子签名（runtime/bridge/worker.ts 安装；返回 null = 不支持 → 回退） */
export type CreateWorkerHook = (
  workerUrl: string,
  protocol: ChannelWorkerProtocol,
) => ChannelWorkerPort | null;

/** 读全局钩子（globalThis 形态；桥接层经 setGlobal 双写，这里只读一次） */
function readCreateWorkerHook(): CreateWorkerHook | null {
  const candidate = (globalThis as { __tveCreateWorker?: CreateWorkerHook }).__tveCreateWorker;
  return typeof candidate === "function" ? candidate : null;
}

/** DOM module Worker → 渠道端口适配（transfer 列表原样透传） */
function fromDomWorker(worker: Worker): ChannelWorkerPort {
  const port: ChannelWorkerPort = {
    postMessage(message, transfer) {
      worker.postMessage(message, transfer ?? []);
    },
    onmessage: null,
    onerror: null,
    terminate() {
      worker.terminate();
    },
  };
  worker.onmessage = (ev: MessageEvent) => {
    port.onmessage?.({ data: ev.data });
  };
  worker.onerror = (ev: ErrorEvent) => {
    port.onerror?.({ message: ev.message });
  };
  return port;
}

/**
 * 创建渠道 Worker 端口（平台钩子优先，原生 module Worker 兜底）。
 * @param workerUrl Worker 模块 URL（web 多文件导出；平台渠道/单页可为空串）
 * @param protocol  协议名（平台单实例 Worker 的 ns 复用键）
 * @param label     诊断标签（回退告警前缀，如 "[物理]"）
 * @returns 端口；null = 当前渠道/协议不支持 Worker（调用方回退主线程实现）
 */
export function createChannelWorker(
  workerUrl: string,
  protocol: ChannelWorkerProtocol,
  label: string,
): ChannelWorkerPort | null {
  const hook = readCreateWorkerHook();
  if (hook) {
    try {
      return hook(workerUrl, protocol);
    } catch (e) {
      console.warn(
        `[TvE] ${label} Worker 桥接创建失败，回退主线程（${e instanceof Error ? e.message : String(e)}）`,
      );
      return null;
    }
  }
  if (!workerUrl) return null;
  try {
    return fromDomWorker(new Worker(workerUrl, { type: "module" }));
  } catch {
    return null;
  }
}
