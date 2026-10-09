// 桥接核心 · 存储：localStorage 形态（平台端点同步存储为后端）。
// 迭代/清空能力端点未提供（存储盒不透明）：key(i)/clear 按 best-effort 处理。

import { host, bridgeActive } from "./host.ts";
import { setGlobal, windowRef } from "./install.ts";

/** localStorage 门面形态（引擎/pak 消费的标准子集；迭代能力端点未提供） */
type LocalStorageShim = Pick<Storage, "length" | "getItem" | "setItem" | "removeItem" | "clear" | "key">;

export function installStorageGlobals(): void {
  if (!bridgeActive()) return;
  const store: LocalStorageShim = {
    length: 0,
    getItem(key: string): string | null {
      const v = host()!.storageGet(String(key));
      return v == null ? null : String(v);
    },
    setItem(key: string, value: string): void {
      host()!.storageSet(String(key), String(value ?? ""));
    },
    removeItem(key: string): void {
      host()!.storageRemove(String(key));
    },
    clear(): void {
      /* 端点未提供全清能力：静默跳过（localStorage 语义允许失败） */
    },
    key(): string | null {
      /* 端点未提供枚举能力：返回 null */
      return null;
    },
  };
  setGlobal("localStorage", store);
  try {
    const w = windowRef.current;
    if (w) w.localStorage = store;
  } catch {
    /* window 未就绪忽略 */
  }
}

// 求值期安装（渠道入口以 import 装配，见 entries 说明）
installStorageGlobals();
