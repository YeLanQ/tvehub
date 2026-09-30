// 适配层 · 存储：localStorage 形态（wx 同步存储为后端，统一命名空间键前缀）。

import { isWechatRuntime, setGlobal, windowRef, wxApi } from "./env.js";

const NS = "__tve_wx_local_storage__";

function storageGet(key) {
  try {
    const box = wxApi.getStorageSync(NS) || {};
    return box[key];
  } catch {
    return undefined;
  }
}

function storageSet(key, value) {
  try {
    const box = wxApi.getStorageSync(NS) || {};
    box[key] = value;
    wxApi.setStorageSync(NS, box);
  } catch {
    /* 存储失败按静默（localStorage 语义本就允许失败） */
  }
}

function storageRemove(key) {
  try {
    const box = wxApi.getStorageSync(NS) || {};
    delete box[key];
    wxApi.setStorageSync(NS, box);
  } catch {
    /* 同上 */
  }
}

export function installStorageGlobals() {
  if (!isWechatRuntime || !wxApi || typeof wxApi.getStorageSync !== "function") return;
  const store = {
    length: 0,
    getItem(key) {
      const v = storageGet(String(key));
      return v == null ? null : String(v);
    },
    setItem(key, value) {
      storageSet(String(key), String(value ?? ""));
      refreshLength(store);
    },
    removeItem(key) {
      storageRemove(String(key));
      refreshLength(store);
    },
    clear() {
      try {
        wxApi.removeStorageSync(NS);
      } catch {
        /* 同上 */
      }
      refreshLength(store);
    },
    key(index) {
      const box = storageGetAll();
      const keys = Object.keys(box || {});
      return index >= 0 && index < keys.length ? keys[index] : null;
    },
  };
  refreshLength(store);
  setGlobal("localStorage", store);
  try {
    const w = windowRef.current;
    if (w) w.localStorage = store;
  } catch {
    /* window 未就绪忽略 */
  }
}

function storageGetAll() {
  try {
    return wxApi.getStorageSync(NS) || {};
  } catch {
    return {};
  }
}

function refreshLength(store) {
  try {
    store.length = Object.keys(storageGetAll() || {}).length;
  } catch {
    store.length = 0;
  }
}

// 求值期安装（bootstrap 以 import 装配，见该文件说明）
installStorageGlobals();
