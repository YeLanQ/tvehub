// ---------------------------------------------------------------------------
// asset:// 协议 URL 构造（前端唯一的二进制资产取数入口）：
// 模型/贴图由 WebView 经自定义协议直接向 Rust 流式请求（返回原始字节），
// 不再走 invoke + base64 文本（消除大字符串过 IPC 与 JS atob 解码开销）。
// convertFileSrc 负责抹平平台差异（Windows/Linux 实际为 http://asset.localhost/…）。
// ---------------------------------------------------------------------------

import { convertFileSrc } from "@tauri-apps/api/core";
import { INTERNAL_ROOT } from "./internal-assets";

/** 资产相对路径 → asset:// 协议 URL（internal/… → 内置资源范围，其余 → 项目根） */
export function assetUrl(rel: string): string {
  const prefix = `${INTERNAL_ROOT}/`;
  const scoped = rel.startsWith(prefix) ? `i/${rel.slice(prefix.length)}` : `p/${rel}`;
  return convertFileSrc(scoped, "asset");
}

/** 经协议拉取资产二进制（ArrayBuffer）；不存在/失败返回 null */
export async function fetchAssetBinary(rel: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(assetUrl(rel));
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}
