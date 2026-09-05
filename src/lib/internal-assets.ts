// ---------------------------------------------------------------------------
// 编辑器内置资源（internal/…）路径约定：
// 资源本体 = public/internal 真实目录（唯一事实源）。开发直接读仓库目录；
// 生产经 build.rs 打包、启动释放到 exe 同级 public/internal；扫描/读取由后端命令
// scan_internal_assets / read_internal_asset / read_internal_binary 完成（LQEN 同款，
// 前端不持有/不生成清单）。本模块只提供路径判定，内容统一走 api。
// ---------------------------------------------------------------------------

/** internal 目录只读根（与工程 assets/、src/ 并列展示在资产面板左树） */
export const INTERNAL_ROOT = "internal";

/** 判断资产是否位于编辑器内置目录（internal） */
export function isInternalAsset(rel: string): boolean {
  return rel === INTERNAL_ROOT || rel.startsWith("internal/");
}
