// ---------------------------------------------------------------------------
// 资产目录保护判定（资产面板 / 资产 store 共用）：
// - internal/… ：编辑器内置资源（只读；文件可「复制到项目」）
// - assets、src ：项目根级固定目录（不随项目结构变化，不允许复制/重命名/删除/移动）
// 目录**内部**的文件仍可正常编辑；assets/src 内可新建子目录。
// ---------------------------------------------------------------------------

import { isInternalAsset } from "../../lib/internal-assets";

/** 项目根级固定目录名（资产面板固定展示，不允许当作普通资产操作） */
export const PROJECT_ROOT_DIRS = ["assets", "src"] as const;

/** 是否为项目根级固定目录（assets / src 本身） */
export function isProjectRootDir(rel: string): boolean {
  return rel === "assets" || rel === "src";
}

/** 资产是否受保护（内置资源 或 项目根级固定目录） */
export function isProtectedAsset(rel: string): boolean {
  return isInternalAsset(rel) || isProjectRootDir(rel);
}
