// ---------------------------------------------------------------------------
// 脚本原型（创意工坊 code 分类）类型与注入工具：
// 原型是 public/repos/code/<原型名>.ts 下的独立文件（一个原型一个文件）；
// - 描述写在文件首部注释 // @desc: xxx（可缺省）；
// - 代码支持 {{CLASS_NAME}} 占位符（创建脚本时注入类名）；
// - 目录首次初始化时自动播种「基础脚本.ts」（内置模板，之后与普通原型无异）。
// 原型的扫描/读写与分类遍历统一走 lib/repos.ts（资产面板右键菜单与首页工坊共用）；
// 本文件只保留「创建脚本」链路需要的类型与占位符注入。
// ---------------------------------------------------------------------------

export interface ScriptPrototype {
  /** 文件名（含 .ts，如 "Spin.ts"） */
  id: string;
  /** 原型名（文件名去 .ts） */
  name: string;
  description: string;
  /** 模板代码；支持 {{CLASS_NAME}} 占位符（创建脚本时替换为脚本类名） */
  code: string;
}

/** 模板代码注入：{{CLASS_NAME}} → 脚本类名（PascalCase，由调用方给出） */
export function injectClassName(code: string, className: string): string {
  return code.replace(/\{\{\s*CLASS_NAME\s*\}\}/g, className);
}
