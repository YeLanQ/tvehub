// 桥接层 · host 容器：平台端点在自身求值期 setHost 注册（渠道入口把平台模块
// 排在核心模块之前），核心模块经 host() 取能力。host 缺席（node 校验/冒烟等
// 非 minigame 环境）时 bridgeActive() 为 false → 核心安装整体空转。

import { assertHost } from "./contract.js";

let current = null;

/** 注册平台端点（注册期 assertHost 校验实现完整性） */
export function setHost(endpoint) {
  current = assertHost(endpoint);
}

/** 当前平台端点（未注册为 null） */
export function host() {
  return current;
}

/** 桥接是否激活：端点已注册且平台可用（wx 缺席时端点 available() 为 false） */
export function bridgeActive() {
  try {
    return !!(current && current.available());
  } catch {
    return false;
  }
}
