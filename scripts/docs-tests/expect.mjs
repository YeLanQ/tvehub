// doctest 断言比较：块内 `expr; // => 期望` 被改写为 __docExpect(expr, "期望", tag)。
// 期望值为源文本（JSON 或 undefined/NaN/Infinity），比较规则：
// - 数值近似（绝对误差 ≤ 1e-6），规避浮点尾数漂移；
// - 对象/数组递归同构比较（数值叶子同样近似）；
// - 其余严格相等。

const NUM_EPS = 1e-6;

// 标量字面量前缀：数字 / 字符串 / true/false/null/undefined/NaN/±Infinity
const SCALAR_RE = /^(undefined|NaN|-?Infinity|true|false|null|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/;

/** 从期望值源文本提取最长合法字面量前缀（其后允许跟中文说明，忽略） */
function literalPrefix(src) {
  const t = src.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    // 平衡扫描配对的闭合括号（字符串内的括号与转义不算）
    const open = t[0];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (c === "\\") i++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) return t.slice(0, i + 1);
      }
    }
    return null;
  }
  const m = t.match(SCALAR_RE);
  return m ? m[0] : null;
}

/** 解析期望值源文本 → JS 值（JSON 或 undefined/NaN/Infinity；允许尾部说明文本） */
export function parseExpected(src) {
  const prefix = literalPrefix(src);
  if (prefix == null) throw new Error(`期望值不是合法字面量：${src.trim()}`);
  const t = prefix;
  if (t === "undefined") return undefined;
  if (t === "NaN") return NaN;
  if (t === "Infinity") return Infinity;
  if (t === "-Infinity") return -Infinity;
  try {
    return JSON.parse(t);
  } catch {
    throw new Error(`期望值不是合法字面量：${t}`);
  }
}

function bothNum(a, b) {
  return typeof a === "number" && typeof b === "number";
}

/** 深比较（数值近似；数组/普通对象递归） */
export function deepEqual(a, b) {
  if (bothNum(a, b)) {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return Math.abs(a - b) <= NUM_EPS;
  }
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

/** 值的显示形式（错误信息用） */
export function display(v) {
  if (typeof v === "number") return Number.isNaN(v) ? "NaN" : String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// —— 运行时注入块内的断言入口（run-blocks 经 import 接线） ——

const failures = [];

export function __docExpect(actual, expectedSrc, tag) {
  let expected;
  try {
    expected = parseExpected(expectedSrc);
  } catch (e) {
    failures.push(`${tag}: ${e.message}`);
    return;
  }
  if (!deepEqual(actual, expected)) {
    failures.push(`${tag}: 期望 ${display(expected)}，实际 ${display(actual)}`);
  }
}

export function resetFailures() {
  failures.length = 0;
}

export function drainFailures() {
  return failures.splice(0, failures.length);
}
