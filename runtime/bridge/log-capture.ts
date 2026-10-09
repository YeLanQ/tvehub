// 桥接核心 · 引擎日志捕获（真机诊断读出面）：debug 构建的引擎 postLog 走
// __tveWorkerLog 钩子优先链（core/log.ts 首查该钩子）；主线程本钩子缺席时
// postLog 落 window.parent.postMessage（真机控制台不中继 = 不可见）。这里在
// 主线程装同一钩子：环形缓冲供诊断弹窗读出（脚本加载失败/物理回退等引擎侧
// error/warn 真机首次可见），同时镜像 console 保持既有可见性语义。
// 本模块仅微信 bundle 装配（entries/wechat）；web 渠道零改动零影响。

import { bridgeActive } from "./host.ts";
import { setGlobal } from "./install.ts";
import { TVE_WORKER_LOG_HOOK } from "./protocol.ts";

interface LogRec {
  lv: string;
  tx: string;
}

const ring: LogRec[] = [];
const RING_MAX = 30;

export function installLogCapture(): void {
  if (!bridgeActive()) return;
  setGlobal(TVE_WORKER_LOG_HOOK, (lv: unknown, tx: unknown) => {
    const rec: LogRec = { lv: String(lv ?? "info"), tx: String(tx ?? "").slice(0, 200) };
    ring.push(rec);
    if (ring.length > RING_MAX) ring.shift();
    try {
      if (rec.lv === "error") console.error("[tve]", rec.tx);
      else if (rec.lv === "warn") console.warn("[tve]", rec.tx);
      else console.log("[tve]", rec.tx);
    } catch {
      /* console 缺席静默 */
    }
  });
}

/** 诊断弹窗用日志尾读出：近 10 条内优先最后一条 error/warn，否则最后一条；
 *  单条截 60 字（弹窗宽度预算）。无记录返回「无」。 */
export function logTail(): string {
  if (!ring.length) return "无";
  for (let i = ring.length - 1; i >= 0 && i >= ring.length - 10; i--) {
    const r = ring[i];
    if (r.lv === "error") return `E:${r.tx.slice(0, 60)}`;
    if (r.lv === "warn") return `W:${r.tx.slice(0, 60)}`;
  }
  return `I:${ring[ring.length - 1].tx.slice(0, 60)}`;
}

// 求值期安装（bootstrap 以 import 装配；钩子按调用时读全局，早晚无害）
installLogCapture();
