// ---------------------------------------------------------------------------
// 编辑器内置资源（internal/…）：随编辑器发布的只读资产。
// 与 public/internal 目录、src-tauri/src/internal.rs 的内嵌表保持同一份清单。
// internal 只保留引擎必需的系统材质（网格默认回退材质 Default）；
// 配色类材质应由用户复制到项目 assets/materials/ 后编辑，不作为内置资产。
// ---------------------------------------------------------------------------

import type { AssetEntry } from "./api";

export interface InternalAssetItem {
  /** 相对路径（以 "internal/" 为根，正斜杠） */
  rel: string;
  /** 展示名（不含扩展名） */
  name: string;
}

/** 内置材质资产清单 */
export const INTERNAL_MATERIAL_ITEMS: InternalAssetItem[] = [
  { rel: "internal/materials/Default.mat", name: "Default" },
];

/** 判断资产是否位于编辑器内置目录（internal） */
export function isInternalAsset(rel: string): boolean {
  return rel === "internal" || rel.startsWith("internal/");
}

/**
 * 内置资源平铺条目（含逐级目录），供资产面板与项目资产合并展示：
 * 项目扫描条目以项目相对路径为根，内置条目以 "internal/" 为根，二者并列。
 */
function buildInternalEntries(): AssetEntry[] {
  const out: AssetEntry[] = [];
  const dirs = new Set<string>();
  for (const item of INTERNAL_MATERIAL_ITEMS) {
    const parts = item.rel.split("/");
    // 逐级补目录（internal、internal/materials）
    let acc = "";
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      if (!dirs.has(acc)) {
        dirs.add(acc);
        out.push({ name: parts[i], path: acc, kind: "dir", size: 0 });
      }
    }
    const name = parts[parts.length - 1] ?? item.rel;
    out.push({
      name,
      path: item.rel,
      kind: name.split(".").pop()?.toLowerCase() ?? "bin",
      size: 0,
    });
  }
  return out;
}

/** 内置资源条目（只读展示；资产面板据此合并进树/内容区） */
export const INTERNAL_ASSET_ENTRIES: AssetEntry[] = buildInternalEntries();
