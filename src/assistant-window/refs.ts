// ---------------------------------------------------------------------------
// @文件引用解析：输入框只保留紧凑的 @路径 令牌；发送时才解析——
// 文本文件把全文注入 wire 消息，模型/音频等二进制只按文件名注入（无内容）。
// 引用格式：@相对路径；路径含空格时用 @[相对路径]。
// 纯函数集中在本模块（无 Vue / Tauri 依赖），可被单测直接覆盖。
// ---------------------------------------------------------------------------

/** 视为"数据文件"的扩展名：只注入文件名，不读内容 */
export const BINARY_REF_EXTS = new Set([
  "glb", "fbx", "obj", "stl", "bin",
  "png", "jpg", "jpeg", "webp", "bmp", "gif", "hdr",
  "mp3", "wav", "ogg", "m4a", "aac", "flac",
]);

export function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i >= 0 ? path.slice(i + 1).toLowerCase() : "";
}

export function isBinaryRef(path: string): boolean {
  return BINARY_REF_EXTS.has(extOf(path));
}

/** 从文本解析 @文件引用（支持 @[带空格路径] 与 @无空格路径），去重保序 */
export function parseFileRefs(text: string): string[] {
  const out: string[] = [];
  const re = /@\[([^\]\n]+)\]|@([^\s@，。；：、“”（）【】《》]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const p = (m[1] ?? m[2] ?? "").trim();
    // 裸令牌须像路径（含 / 或 .），避免把"@的"这类语气误当文件
    if (p && (p.includes("/") || p.includes(".")) && !out.includes(p)) out.push(p);
  }
  return out;
}
