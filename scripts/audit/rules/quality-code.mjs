// ---------------------------------------------------------------------------
// 质量规则 · 代码质量：空 catch（异常处理）、console 残留、文件超长（模块化
// 100~200 行约定）、函数超长/圈复杂度启发式（复杂度）、串行 await 与深拷贝
// 反模式（性能）、Rust unsafe。函数边界用花括号深度跟踪（字符串/注释已剥离），
// 属启发式口径，Major 及以下不破防线。
// ---------------------------------------------------------------------------
import { makeFinding } from "../lib/finding.mjs";
import { vueScriptOf } from "../lib/collect.mjs";

/** 剥离字符串字面量与注释，只留结构（花括号计数用，启发式） */
function stripLiterals(ln) {
  return ln
    .replace(/\/\/.*$/, "")
    .replace(/\/\*.*?\*\//g, "")
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
}

const TS_FN_START = /(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(|=>\s*\{|\b([A-Za-z_$][\w$]*)\s*\([^;{)]*\)\s*\{\s*$)/;
const RS_FN_START = /^\s*(?:pub\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([a-z_][\w]*)/;

export function scanQualityCode(files) {
  const out = [];
  for (const f of files) {
    if (f.kind === "config" || f.kind === "env" || f.kind === "script") {
      out.push(...scanScriptQuality(f));
      continue;
    }
    const isRs = f.kind === "rs";
    const text = f.kind === "vue" ? vueScriptOf(f) : f.text;
    const lines = text.split(/\r?\n/);
    const offset = f.kind === "vue" ? (f.text.slice(0, f.text.indexOf(text)).split(/\r?\n/).length - 1) : 0;

    // 文件长度（vue 只按 script 段口径算，模板/样式另论）
    if (lines.length > 400) {
      out.push(mk(f, "quality.file-xl", "major", 1, `${lines.length} 行`, `文件超长（${lines.length} 行 > 400）：拆分后再演进（仓库约定 100~200 行/文件）`));
    } else if (lines.length > 200) {
      out.push(mk(f, "quality.file-long", "minor", 1, `${lines.length} 行`, `文件超过 200 行约定（${lines.length} 行）：排期模块化拆分`));
    }

    let fn = null; // { name, startIdx, depth0, complexity }
    let depth = 0;
    const KEYWORD_FN = /^\s*(?:if|for|while|switch|catch|else|function|return|match|loop)\b/;
    lines.forEach((raw, i) => {
      const ln = stripLiterals(raw);
      depth += (ln.match(/\{/g) || []).length;
      depth -= (ln.match(/\}/g) || []).length;

      const startMatch = !fn && !KEYWORD_FN.test(raw) && (isRs ? RS_FN_START.test(raw) : TS_FN_START.test(raw));
      if (startMatch) {
        const name = (isRs ? raw.match(RS_FN_START)?.[1] : raw.match(TS_FN_START)?.[1] ?? raw.match(/\b(?:function|const|let)\s+([A-Za-z_$][\w$]*)/)?.[1]) ?? "(匿名)";
        fn = { name, startIdx: i, depth0: depth, complexity: 0 };
      } else if (fn) {
        const decision = raw.match(isRs ? /\b(if|for|while|match|else)\b|&&|\|\||\?/g : /\b(if|for|while|case|catch|else)\b|&&|\|\||\?\?|\?\./g) ?? [];
        fn.complexity += decision.length;
      }
      if (fn && depth <= fn.depth0 && i > fn.startIdx) {
        const len = i - fn.startIdx + 1;
        if (len > 120) out.push(mk(f, "quality.fn-xl", "major", fn.startIdx + 1 + offset, raw.trim().slice(0, 80), `函数 ${fn.name} 超 120 行（${len} 行）：拆分`));
        else if (len > 80) out.push(mk(f, "quality.fn-long", "minor", fn.startIdx + 1 + offset, raw.trim().slice(0, 80), `函数 ${fn.name} 较长（${len} 行）`));
        if (fn.complexity > 25) out.push(mk(f, "quality.complexity", "major", fn.startIdx + 1 + offset, raw.trim().slice(0, 80), `函数 ${fn.name} 圈复杂度启发值 ${fn.complexity} > 25：分支收敛/提前返回`));
        fn = null;
      }

      // 逐行规则（console：只拦调试残留 log/debug；info/warn/error 是合法分级
      // 通道。豁免：日志汇聚模块本身、tve SDK 控制台透传、.rs 内嵌模板串）
      const isLogSink = /src\/lib\/debug-log\.ts$|runtime\/core\/tve\.ts$/.test(f.rel);
      if (!isRs && !isLogSink && /\bconsole\.(log|debug)\(/.test(raw)) {
        out.push(mk(f, "quality.console", "minor", i + 1 + offset, raw, "console.log/debug 残留（info/warn/error 放行）", "删除或改用统一日志通道"));
      }
      if (/JSON\.parse\(\s*JSON\.stringify/.test(raw)) {
        out.push(mk(f, "perf.clone-roundtrip", "minor", i + 1 + offset, raw, "JSON 往返深拷贝：大对象热路径上代价高", "用 structuredClone"));
      }
      if (isRs && /^\s*unsafe\s/.test(raw)) {
        out.push(mk(f, "quality.rs-unsafe", "major", i + 1 + offset, raw, "Rust unsafe 块：需给出不变量注释并复核", "消除 unsafe 或注明安全论证"));
      }
    });

    // 空 catch（跨行检查，只扫 ts/vue script）
    out.push(...scanEmptyCatch(f, lines, offset));
    // 串行 await in for（性能）：TS only，循环体内首个 await 即报（minor）
    lines.forEach((raw, i) => {
      if (!/^\s*(for|while)\b/.test(raw)) return;
      for (let j = i + 1; j < Math.min(i + 25, lines.length); j++) {
        if (/\}/.test(lines[j])) break;
        if (/\bawait\b/.test(lines[j])) {
          out.push(mk(f, "perf.serial-await", "minor", j + 1 + offset, lines[j], "循环内串行 await：IO 密集时考虑 Promise.all 并行", "确认顺序依赖是设计内；否则并行化"));
          break;
        }
      }
    });
  }
  return out;
}

function mk(f, rule, severity, line, snippet, message, fix = "见仓库规范") {
  return makeFinding({ rule, dimension: "quality", category: CATEGORY[rule] ?? "代码质量", severity, file: f.rel, line, snippet, message, fix });
}
const CATEGORY = {
  "quality.file-xl": "复杂度", "quality.file-long": "复杂度", "quality.fn-xl": "复杂度",
  "quality.fn-long": "复杂度", "quality.complexity": "复杂度", "quality.console": "规范残留",
  "perf.clone-roundtrip": "性能", "perf.serial-await": "性能", "quality.rs-unsafe": "异常处理",
};

/** 空 catch / 仅注释 catch：异常处理维度的重点（吞错会让故障静默化） */
function scanEmptyCatch(f, lines, offset) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/\bcatch\b/.test(lines[i])) continue;
    // 单行 catch：`catch (e) { doX(); }` —— 同行花括号内有实际语句即非空
    const inline = lines[i].match(/\{\s*([^{}]*)\}/);
    if (inline && /\b\w+\s*\(/.test(inline[1])) continue;
    let braceSeen = /\{/.test(lines[i]);
    for (let j = i + (braceSeen ? 1 : 0); j < Math.min(i + 16, lines.length); j++) {
      const t = lines[j].trim();
      if (t.startsWith("}")) {
        out.push(mk(f, "quality.empty-catch", "major", i + 1 + offset, lines[i], "空 catch 吞掉全部异常（仅注释也视为空）：故障静默化", "至少记录错误（console.warn/上报），或显式 rethrow"));
        break;
      }
      if (t === "" || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) continue;
      break; // 有实际语句 → 非空
    }
  }
  return out;
}

/** scripts/ 下的工程脚本：只查 console（宽松）与超长 */
function scanScriptQuality(f) {
  const out = [];
  if (f.lines.length > 400) {
    out.push(mk(f, "quality.file-xl", "major", 1, `${f.lines.length} 行`, `脚本超长（${f.lines.length} 行）：拆分`));
  }
  return out;
}
