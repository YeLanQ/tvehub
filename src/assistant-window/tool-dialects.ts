// 通用工具调用语法引擎（结构识别）：以「结构」而非「品牌」识别正文里的
// 调用标记。各模型把调用写进正文的方言层出不穷（DeepSeek DSML 的
// <｜DSML｜ invoke …>、Claude 系 <invoke><parameter>、<function=x> 裸等号…），
// 逐家堆正则永远追不完——凡见「标签头或其紧跟词带 invoke / parameter / calls
// 语义词」的成对标记即按结构化调用解析（词表驱动，新方言零代码兼容，任意
// 前缀装饰字符与属性拼写均可）。非标记壳与痕迹/净化出口分别在
// ./tool-dialect-shells 与 ./tool-dialect-sanitize。
// 安全边界：显式声明为 JSON（string="false"）却解析失败视为载荷残缺——只剥离
// 不执行，防止把半截参数真跑出去（如 asset.write 写坏文件）；正文截断的
// 尾部未闭合调用块同理（被相邻 invoke 顶替且参数完整时仍照常执行）。

import type { ToolCall } from "./agent";
import { decodeEntities } from "./labeled-calls";
import { scanExoticShells } from "./tool-dialect-shells";
import { assembleCall, convertValue } from "./tool-dialect-values";

export interface ParsedDialect {
  calls: ToolCall[];
  ranges: Array<[number, number]>;
}

type Semantic = "invoke" | "param" | "wrapper";

interface TagToken {
  start: number;
  end: number;
  close: boolean;
  /** 自闭合（<x invoke name="a"/>）：无参数体，属性即全部 */
  self: boolean;
  /** 标签头（< 与 > 之间首个空白前的词，小写）：与 semantic 一起构成配对键 */
  head: string;
  semantic: Semantic | null;
  attrs: Record<string, string>;
}

/** 语义词分类：词即标签语义（invoke=调用 / param=参数 / wrapper=calls 壳）。
 * 词表只挂「标签头本身或紧跟其后的第一个词」，属性值里出现同名词不误判。 */
function wordClass(word: string): Semantic | null {
  if (/^(?:parameters?|arguments?|params?|args?)$/i.test(word)) return "param";
  if (/^(?:invokes?|functions?|function_calls?)$/i.test(word)) return "invoke";
  if (/^(?:tool_calls?|calls?|tools?)$/i.test(word)) return "wrapper";
  return null;
}

/** 壳词（挂在 name 上的不是工具名，是壳语义：<function=tool_call>） */
const WRAPPER_NAME_RE = /^(?:tool_?calls?|invoke|function|call)$/i;

/** 属性区解析：name="x" / name='x' / name=x；裸等号方言 <parameter=k> 的 = 值
 * 补为 name（无名字属性时；值须是干净词元，<function=name="x"> 这类残缺
 * 拼接不当名字） */
function parseAttrs(s: string, headRaw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/g)) {
    out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? "").trim();
  }
  if (!out.name) {
    const eq = headRaw.indexOf("=");
    if (eq >= 0) {
      const bare = headRaw.slice(eq + 1).replace(/^["']|["']$/g, "").trim();
      if (bare && /^[\w.:/-]+$/.test(bare)) out.name = bare;
    }
  }
  if (out.name && WRAPPER_NAME_RE.test(out.name)) delete out.name;
  return out;
}

/** < 前缀 + 任意装饰字符 + 词 + 属性 + > 的成对标记（不含跨标记的 < >） */
const TAG_TOKEN_RE = /<\/?\s*[^\s<>][^<>]*>/g;

export function tokenize(text: string): TagToken[] {
  const out: TagToken[] = [];
  for (const m of text.matchAll(TAG_TOKEN_RE)) {
    const raw = m[0];
    const close = raw.startsWith("</");
    const inner = (close ? raw.slice(2, -1) : raw.slice(1, -1)).trim();
    if (!inner) continue;
    const self = !close && inner.endsWith("/");
    const body = self ? inner.slice(0, -1) : inner;
    const headRaw = body.split(/\s/, 1)[0] ?? "";
    const word1 = headRaw.replace(/=.*$/, "");
    const word2 = body.slice(headRaw.length).trimStart().split(/\s/, 1)[0] ?? "";
    out.push({
      start: m.index ?? 0,
      end: (m.index ?? 0) + raw.length,
      close,
      self,
      head: word1.toLowerCase(),
      semantic: wordClass(word1) ?? wordClass(word2),
      attrs: parseAttrs(body, headRaw),
    });
  }
  return out;
}

interface OpenCall {
  start: number;
  name: string;
  params: Array<[string, unknown]>;
  broken: boolean;
}

/** 扫描正文里的结构化标记调用（DSML / invoke / 任意标记模板）。
 * 未闭合的调用块（被后续标记顶替或正文截断）只产出剥离区间、不产出调用。 */
export function scanTagCalls(text: string): ParsedDialect {
  const calls: ToolCall[] = [];
  const ranges: Array<[number, number]> = [];
  let cur: OpenCall | null = null;
  let param: { key: string; strFlag: string; bodyStart: number } | null = null;
  let wrapperStart = -1;
  let wrapperHasCall = false;

  const finish = (c: OpenCall, end: number, exec: boolean): void => {
    // 载荷残缺（JSON 声明解析失败）：绝不执行，只留剥离区间防半截参数跑出去
    const call = exec && !c.broken ? assembleCall(c.name, c.params) : null;
    if (call) {
      calls.push(call);
      if (wrapperStart >= 0) wrapperHasCall = true;
    }
    // 无名且无参的空壳（如泛型 Array<function>）不是调用残骸：不产剥离区间
    if (call || c.name || c.params.length > 0 || param) ranges.push([c.start, end]);
  };
  const closeParam = (end: number): void => {
    if (!param) return;
    if (cur) {
      const body = decodeEntities(text.slice(param.bodyStart, end).trim());
      const { v, broken } = convertValue(body, param.strFlag, param.key);
      if (broken) cur.broken = true;
      else cur.params.push([param.key, v]);
    }
    param = null;
  };

  for (const t of tokenize(text)) {
    // 参数体在结构标记处截断；截断标记（相邻 invoke 开标签等）说明前一个
    // 调用漏了闭合标签——参数体完整时仍按可执行处理（残缺由 broken 兜底）
    let strayParam = false;
    if (param && t.semantic !== null) {
      strayParam = true;
      closeParam(t.start);
    }
    if (t.semantic === "param") {
      if (t.close) closeParam(t.start);
      else param = { key: t.attrs.name ?? "", strFlag: (t.attrs.string ?? "").toLowerCase(), bodyStart: t.end };
      continue;
    }
    if (t.semantic === "invoke") {
      if (t.close) {
        if (cur) finish(cur, t.end, true);
        cur = null;
      } else {
        if (cur) finish(cur, t.start, !strayParam);
        if (t.self) finish({ start: t.start, name: t.attrs.name ?? "", params: [], broken: false }, t.end, true);
        else cur = { start: t.start, name: t.attrs.name ?? "", params: [], broken: false };
      }
      continue;
    }
    if (t.semantic === "wrapper") {
      if (t.close) {
        if (wrapperStart >= 0 && wrapperHasCall) ranges.push([wrapperStart, t.end]);
        wrapperStart = -1;
        wrapperHasCall = false;
      } else if (wrapperStart < 0) {
        wrapperStart = t.start;
      }
    }
  }
  if (param && cur) closeParam(text.length);
  if (cur) finish(cur, text.length, false);
  return { calls, ranges };
}

/** 通用方言扫描入口：优先结构标记（DSML 等），没有产出再试非标记壳 */
export function scanDialectCalls(text: string): ParsedDialect {
  const tag = scanTagCalls(text);
  if (tag.calls.length) return tag;
  return scanExoticShells(text);
}
