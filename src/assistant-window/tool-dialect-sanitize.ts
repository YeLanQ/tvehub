// 通用工具调用语法引擎（痕迹检测 + 出口净化）：解析失败的结构方言残骸
// （DSML 等任意标记模板）的坏格式纠偏判据与上屏兜底剥离。
// 结构识别在 ./tool-dialects，非标记壳在 ./tool-dialect-shells。
import { tokenize } from "./tool-dialects";

/** 正文里是否残留结构方言的调用痕迹（invoke 带名 / 参数槽 / calls 壳），
 * 供「有调用但全没解析出来」的坏格式纠偏判据；<function> 泛型等无名形状不误伤 */
export function hasTagCallTrace(text: string): boolean {
  for (const t of tokenize(text)) {
    if (!t.semantic) continue;
    if (t.semantic === "invoke" && !t.close && !t.attrs.name) continue;
    return true;
  }
  return false;
}

/** 出口净化：剥结构方言残骸（带名 invoke 块 / 参数槽 / wrapper 壳，未闭合剔到
 * 尾），供最终上屏文本兜底；无名 <function> 等代码形状不碰 */
export function stripTagCalls(text: string): string {
  const tokens = tokenize(text);
  if (!tokens.some((t) => t.semantic)) return text;
  const opens = new Set(tokens.filter((t) => !t.close && t.semantic).map((t) => `${t.head}\u0000${t.semantic}`));
  const cuts: Array<[number, number]> = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.semantic) continue;
    if (t.semantic === "invoke" && !t.close && !t.attrs.name) continue; // 无名形状不碰
    if (t.close) {
      // 孤儿闭合：配对出现过或装饰性词元（如 ｜DSML｜）才剔标记本身
      if (opens.has(`${t.head}\u0000${t.semantic}`) || /[^\x00-\x7F]/.test(t.head)) cuts.push([t.start, t.end]);
      continue;
    }
    // 开标记：成对剔到同名闭合，未闭合剔到尾
    let end = text.length;
    for (let j = i + 1; j < tokens.length; j++) {
      if (tokens[j].close && tokens[j].head === t.head && tokens[j].semantic === t.semantic) {
        end = tokens[j].end;
        break;
      }
    }
    cuts.push([t.start, end]);
  }
  if (!cuts.length) return text;
  cuts.sort((a, b) => a[0] - b[0]);
  let out = "";
  let pos = 0;
  for (const [s, e] of cuts) {
    if (s < pos) continue;
    out += text.slice(pos, s);
    pos = e;
  }
  return (out + text.slice(pos)).replace(/\n{3,}/g, "\n\n").trim();
}
