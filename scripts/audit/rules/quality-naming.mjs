// ---------------------------------------------------------------------------
// 质量规则 · 命名规范：TS/Vue 变量与函数 camelCase、类型/组件 PascalCase、
// 常量 UPPER_SNAKE、Vue SFC 文件名 PascalCase；Rust 由编译器强制（不查）。
// 白名单：GET_/SET_、__dunder__、aria-/data- 属性、CSS 变量段。
// ---------------------------------------------------------------------------
import { makeFinding } from "../lib/finding.mjs";
import { vueScriptOf } from "../lib/collect.mjs";

const UPPER = /^[A-Z][A-Z0-9_]*$/;
const PASCAL = /^[A-Z][A-Za-z0-9]*$/;
const CAMEL = /^[a-z_$][A-Za-z0-9$]*$/;
const EXEMPT = /^(GET_|SET_|__|\$)/;

export function scanNaming(files) {
  const out = [];
  for (const f of files) {
    if (f.kind !== "ts" && f.kind !== "vue") continue;
    // 1) Vue SFC 文件名 PascalCase
    if (f.kind === "vue") {
      const base = f.rel.split("/").pop().replace(/\.vue$/, "");
      if (!PASCAL.test(base)) {
        out.push(finding(f, "naming.vue-file", 1, f.rel.split("/").pop(), `Vue 组件文件名非 PascalCase（${base}）`));
      }
    }
    const lines = (f.kind === "vue" ? vueScriptOf(f) : f.text).split(/\r?\n/);
    const offset = f.kind === "vue" ? Math.max(0, f.text.split(/\r?\n/).findIndex((l) => l.includes("<script")) ) : 0;
    lines.forEach((ln, i) => {
      if (/^\s*(\/\/|\*|\/\*|<!--)/.test(ln)) return;
      // 2) class/interface/type/enum 声明 PascalCase（行首声明位，排除 `x.type as T`
      //    断言与 `class extends X` 匿名类两类误报）
      let m = ln.match(/^\s*(?:export\s+|declare\s+|abstract\s+)*(class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/);
      if (m && !["extends", "implements", "as", "const", "keyof", "in"].includes(m[2]) && !PASCAL.test(m[2])) {
        out.push(finding(f, "naming.type", i + 1 + offset, m[0], `类型 ${m[2]} 非 PascalCase`));
      }
      // 3) 变量/常量：camelCase 或 UPPER_SNAKE；禁 snake_case 混用。
      //    *Ctor（构造器引用，three 生态惯用法）与 dunder 前缀放行
      m = ln.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?==)/);
      if (m && !EXEMPT.test(m[1]) && !/Ctor$/.test(m[1]) && !UPPER.test(m[1]) && !CAMEL.test(m[1])) {
        out.push(finding(f, "naming.variable", i + 1 + offset, m[0], `变量 ${m[1]} 非 camelCase/UPPER_SNAKE`));
      }
      // 4) 函数声明 camelCase（允许 PascalCase 的组件定义函数）
      m = ln.match(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/);
      if (m && !CAMEL.test(m[1]) && !PASCAL.test(m[1])) {
        out.push(finding(f, "naming.function", i + 1 + offset, m[0], `函数 ${m[1]} 非 camelCase`));
      }
    });
  }
  return out;
}

function finding(f, rule, line, snippet, message) {
  return makeFinding({
    rule, dimension: "quality", category: "命名规范", severity: "minor",
    file: f.rel, line, snippet, message, fix: "对齐仓库命名约定（camelCase/UPPER_SNAKE/PascalCase）",
  });
}
