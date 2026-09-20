// ---------------------------------------------------------------------------
// 脚本原型（创意工坊 code 分类）类型与工具：
// 原型是 public/repos/code/<原型名>.ts 下的独立文件（一个原型一个文件）；
// - 描述写在文件首部注释 // @desc: xxx（可缺省）；
// - 代码即成品，导入脚本时原样落盘（类名与文件名一致，不做注入/改写）；
// - 目录首次初始化时自动播种「基础脚本.ts」（内置模板，之后与普通原型无异）。
// 原型的扫描/读写与分类遍历统一走 lib/repos.ts（资产面板右键菜单与首页工坊共用）；
// 本文件只保留「创建脚本」链路需要的类型与文件名→类名工具。
// ---------------------------------------------------------------------------

export interface ScriptPrototype {
  /** 文件名（含 .ts，如 "Spin.ts"） */
  id: string;
  /** 原型名（文件名去 .ts） */
  name: string;
  description: string;
  /** 原型代码；导入脚本时原样落盘（不做占位符替换/类名改写） */
  code: string;
}

/**
 * 文件名 → 脚本类名（PascalCase）：类名恒等于文件名（脚本组件在场景里以
 * `script:<类名>` 为标识）。去重后的文件名（"Rotator 2.ts"）类名须为 "Rotator2"，
 * 不能沿用原名——否则同名类会让脚本组件解析歧义。
 */
export function scriptClassNameFromStem(stem: string, fallback = "MyScript"): string {
  return (
    stem
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((seg) => seg[0].toUpperCase() + seg.slice(1))
      .join("") || fallback
  );
}
