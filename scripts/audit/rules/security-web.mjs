// ---------------------------------------------------------------------------
// 安全规则 · Web 前端面：XSS / 危险执行 / 消息通道 / 开放重定向 / SQL 拼接。
// 覆盖任务口径中的 XSS、CSRF（消息通道与写操作）、SQL 注入（防未来引入）。
// 设计内用法（如用户脚本引擎的 new Function）由台账接受，不静默豁免。
// ---------------------------------------------------------------------------
import { makeFinding } from "../lib/finding.mjs";

/** v-html 绑定是否为纯常量图标表达式（UPPER_SNAKE 及其成员/下标/三元组合） */
function isConstIconExpr(expr) {
  const segments = expr.split("?").pop().split(":");
  return segments.every((s) => /^[A-Z_][A-Z0-9_]*(\[[^\]]*\]|\.[A-Za-z0-9_]+)*$/.test(s.trim()));
}

const PLACEHOLDER = /^(?:["'](?:|test|tests?|dummy|fake|example|sample|placeholder|your[-_][a-z]+|xxx+|<[^>]*>|\$\{[^}]*\})["']|`[^`]*\$\{[^}]*\}[^`]*`)$/;

/** 逐行规则：正则 + 判定函数（捕获组转 severity/message） */
const LINE_RULES = [
  {
    rule: "xss.v-html",
    category: "XSS",
    re: /v-html="([^"]+)"/,
    // 绑定 UPPER_SNAKE 常量/常量成员/常量三元（内置图标等静态 SVG）按设计内降级；
    // 其余动态表达式保持 high 待复核
    severity: (m) => (isConstIconExpr(m[1]) ? "info" : "high"),
    msg: (m) => `v-html 绑定动态表达式（${m[1].slice(0, 60)}）：需确认内容源经过净化（DOMPurify 或纯内部 SVG）`,
    fix: "内容不可信时先经 DOMPurify.sanitize；内部受控 SVG 则入台账接受",
  },
  {
    rule: "xss.innerhtml-assign",
    category: "XSS",
    re: /\.(innerHTML|outerHTML)\s*[+]?=|insertAdjacentHTML\(|document\.write\(/,
    severity: "high",
    msg: () => "直接写 innerHTML/insertAdjacentHTML/document.write —— 绕过 Vue 转义，XSS 首选通道",
    fix: "改用 textContent 或受控渲染；确需富文本则先 sanitize",
  },
  {
    rule: "exec.eval",
    category: "命令/代码执行",
    re: /(^|[^.\w])eval\s*\(|new\s+Function\s*\(/,
    severity: (m, line) => (PLACEHOLDER.test(line.trim()) || /eval\s*\(\s*(["'`])[^"'`]*\1\s*\)/.test(line) ? "info" : "critical"),
    msg: () => "eval / new Function 动态执行字符串代码",
    fix: "用户脚本引擎等设计内场景入台账；否则改显式逻辑",
  },
  {
    rule: "csrf.postmessage-wildcard",
    category: "CSRF/消息通道",
    re: /postMessage\([^)]*,\s*["']\*["']/,
    severity: "high",
    msg: () => "postMessage 目标 origin 使用通配 *",
    fix: "指定确切 origin",
  },
  {
    rule: "csrf.msg-no-origin",
    category: "CSRF/消息通道",
    re: /addEventListener\(\s*["']message["']/,
    // 处理器已校验 e.source/origin 的（全文件可见守卫）按受防护降级
    severity: (m, line, file) => (/worker/i.test(file.rel) || /e\.source|\.origin\s*[!=]==/.test(file.text) ? "info" : "high"),
    msg: () => "监听 message 事件：窗口级监听必须校验 event.origin / event.source",
    fix: "首行判断 e.source === 自家 iframe.contentWindow 或 e.origin；Worker 属设计内",
  },
  {
    rule: "open.redirect-param",
    category: "开放重定向",
    re: /location\.(href|assign|replace)\s*=/,
    severity: (m, line) => (/query|search|param|hash/i.test(line) ? "high" : "info"),
    msg: () => "location 跳转向量来自查询参数/哈希 —— 开放重定向风险",
    fix: "跳转目标用白名单映射",
  },
  {
    rule: "sqli.concat",
    category: "SQL 注入",
    re: /["'`][^"'`]*\b(select|insert|update|delete)\b[^"'`]*["'`]\s*\+|\+\s*["'`][^"'`]*\b(where|from)\b/i,
    severity: "critical",
    msg: () => "SQL 语句与变量拼接 —— 注入通道（当前无 DB，防未来引入）",
    fix: "参数化查询",
  },
  {
    rule: "open.target-blank",
    category: "安全卫生",
    re: /target=["']_blank["']/,
    severity: (m, line) => (/noopener|noreferrer/.test(line) ? "info" : "minor"),
    msg: () => "target=_blank 未带 rel=noopener（tab-nabbing）",
    fix: "补充 rel=\"noopener noreferrer\"",
  },
];

/** @returns {import("../lib/finding.mjs").Finding[]} 形状的数组（jsdoc 类型仅示意） */
export function scanSecurityWeb(files) {
  const out = [];
  for (const f of files) {
    if (f.kind !== "ts" && f.kind !== "vue" && f.kind !== "runtime") continue;
    const scanText = (text, lineOffset) => {
      const lines = text.split(/\r?\n/);
      lines.forEach((ln, i) => {
        if (/^\s*(\/\/|\/\*|\*|#|<!--)/.test(ln)) return; // 纯注释行不报
        for (const r of LINE_RULES) {
          const m = ln.match(r.re);
          if (!m) continue;
          const sev = typeof r.severity === "function" ? r.severity(m, ln, f) : r.severity;
          out.push(makeFinding({
            rule: r.rule, dimension: "security", category: r.category, severity: sev,
            file: f.rel, line: i + 1 + lineOffset, snippet: ln, message: r.msg(m, ln), fix: r.fix,
          }));
        }
      });
    };
    scanText(f.text, 0);
    // vue 模板已在全文扫描内；script 段单独再扫会重复，故只扫一次（上面已含）
  }
  return out;
}
