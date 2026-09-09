// ---------------------------------------------------------------------------
// 脚本原型（代码工坊）：主页「代码工坊」维护、资产面板「新建脚本」选用。
// 存储为独立文件：public/repos/code/<原型名>.ts（一个原型一个文件）；
// - 描述写在文件首行注释 // @desc: xxx（可缺省）；
// - 代码支持 {{CLASS_NAME}} 占位符（创建脚本时注入类名）；
// - 目录首次初始化时自动播种「基础脚本.ts」（内置模板，之后与普通原型无异）。
// ---------------------------------------------------------------------------

import { api, type CodeProtoEntry } from "../../lib/api";

export interface ScriptPrototype {
  /** 文件名（含 .ts，如 "Spin.ts"） */
  id: string;
  /** 原型名（文件名去 .ts） */
  name: string;
  description: string;
  /** 模板代码；支持 {{CLASS_NAME}} 占位符（创建脚本时替换为脚本类名） */
  code: string;
}

/** 全量原型 = repos/code 目录下的 *.ts 文件（逐个读取内容） */
export async function listScriptPrototypes(): Promise<ScriptPrototype[]> {
  const files = await api.listCodeProtos().catch(() => [] as CodeProtoEntry[]);
  return Promise.all(
    files.map(async (f) => ({
      id: f.file,
      name: f.name,
      description: f.description,
      code: await api.readCodeProto(f.file).catch(() => ""),
    })),
  );
}

/** 写入原型文件（新建/覆盖；描述以首行 // @desc: 注释形式保存） */
export async function writeScriptPrototype(
  name: string,
  description: string,
  code: string,
): Promise<void> {
  const head = description.trim() ? `// @desc: ${description.trim()}
` : "";
  await api.writeCodeProto(`${name}.ts`, head + code);
}

/** 删除原型文件（file 含 .ts） */
export async function deleteScriptPrototype(file: string): Promise<void> {
  await api.deleteCodeProto(file);
}

/** 模板代码注入：{{CLASS_NAME}} → 脚本类名（PascalCase，由调用方给出） */
export function injectClassName(code: string, className: string): string {
  return code.replace(/{{s*CLASS_NAMEs*}}/g, className);
}
