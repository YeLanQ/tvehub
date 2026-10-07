// 微信渠道 Worker bundle 入口（构建产物 workers/<backend>/tve.js，运行于平台
// worker 线程；构建见 runtime/scripts/wechat/worker.mjs）。装配序 = import 声明序
// （ESM 求值序）：worker-relay 先于物理/动画路由——relay 在自身模块求值期安装的
// __tveInstantiateWasmFile 必须先于 physics.ts 顶层求值期的 wasm-file-hook
// （后者幂等让位先行安装方；安装顺序错位 = fetch 版钩子占位，worker 内 fetch
// 包内 wasm 304 失败且 Promise 无 catch 静默挂死）。
// 物理/动画模拟全量复用 web 产物源（src/runtime/runtime/physics-worker.ts 的
// routePhysicsMessage + createPhysics、animation-worker.ts 的 routeAnimationMessage
// + createAnimations），仅传输层不同：ns 信封 + 拷贝语义（TypedArray 已被主线程
// 桥接数组化，路由按索引读写兼容）。单实例多路复用：wx.createWorker 平台限额每包
// 1 个，physics/animation 两 ns 共享同一 worker 线程（各自独立路由状态）。

import {
  handleBridgePayload,
  postMain,
  receiveFromMain,
} from "../worker-relay.ts";
import { TVE_WORKER_NS_BRIDGE } from "../protocol.ts";
import {
  routePhysicsMessage,
  type PhysicsWorkerIn,
  type PhysicsWorkerReply,
} from "../../../src/runtime/runtime/physics-worker.ts";
import {
  routeAnimationMessage,
  type AnimationWorkerIn,
  type AnimationWorkerReply,
} from "../../../src/runtime/runtime/animation-worker.ts";

// 1) 物理路由（worker 侧单份物理世界；close 由主线程 terminate 负责，此处空实现）
const physicsReply: PhysicsWorkerReply = {
  postMessage(message) {
    postMain("physics", message);
  },
  close() {
    /* 平台 worker 不支持自终止；主线程端口 terminate → 单例 terminate */
  },
};

// 2) 动画路由（worker 侧单份代理绑定 + mixer；dispose 只清路由状态，线程归主线程管）
const animationReply: AnimationWorkerReply = {
  postMessage(message) {
    postMain("animation", message);
  },
  close() {
    /* 同物理：不自终止 */
  },
};

// 3) 下行三通道分发 + 水位去重（bridge 信道 → 字节中继；physics/animation → 路由）
let announcedInit = false;
receiveFromMain((ns, payload) => {
  if (ns === TVE_WORKER_NS_BRIDGE) {
    handleBridgePayload(payload);
    return;
  }
  if (ns === "physics") {
    const msg = payload as { type?: unknown };
    if (!announcedInit && msg && msg.type === "init") {
      announcedInit = true;
      postMain(TVE_WORKER_NS_BRIDGE, { t: "log", text: "init 已接收，开始装配物理世界" });
    }
    void routePhysicsMessage(payload as PhysicsWorkerIn, physicsReply);
    return;
  }
  if (ns === "animation") {
    routeAnimationMessage(payload as AnimationWorkerIn, animationReply);
  }
});

// 4) ready 握手：主线程 ready 门放行此前积压的下行（init 等）
// 通道与环境形态上报（真机/工具 worker 线程全局形态不一，收不到下行或引擎
// 求值走错分支时据此定位）
(() => {
  const envType = (read: () => unknown): string => {
    try {
      const v = read();
      return v === undefined ? "undefined" : typeof v;
    } catch {
      return "throw";
    }
  };
  const hasWorkerGlobal = (() => {
    try {
      return typeof worker !== "undefined" && !!worker;
    } catch {
      return false;
    }
  })();
  const hasSelf = (() => {
    try {
      return typeof self !== "undefined" && !!self;
    } catch {
      return false;
    }
  })();
  const selfKeys = (() => {
    try {
      return typeof self !== "undefined" && self ? Object.keys(self).slice(0, 8).join(",") : "-";
    } catch {
      return "?";
    }
  })();
  const workerKeys = (() => {
    try {
      return typeof worker !== "undefined" && worker ? Object.keys(worker).slice(0, 12).join(",") : "-";
    } catch {
      return "?";
    }
  })();
  const chanTypes = (() => {
    try {
      const w = typeof worker !== "undefined" ? worker : null;
      const s = typeof self !== "undefined" ? self : null;
      return [
        `worker.onMessage=${typeof w?.onMessage}`,
        `worker.postMessage=${typeof w?.postMessage}`,
        `self.onmessage=${typeof s?.onmessage}`,
        `self.postMessage=${typeof s?.postMessage}`,
        `self.addEventListener=${typeof s?.addEventListener}`,
      ].join(" ");
    } catch {
      return "?";
    }
  })();
  postMain(TVE_WORKER_NS_BRIDGE, {
    t: "log",
    text: `通道形态: worker全局=${hasWorkerGlobal} self=${hasSelf} worker.onMessage=${chanTypes} | 环境标识: process=${envType(() => process)} importScripts=${envType(() => importScripts)} window=${envType(() => window)} document=${envType(() => document)}`,
  });
})();
postMain(TVE_WORKER_NS_BRIDGE, { t: "ready" });
