// ---------------------------------------------------------------------------
// .shader 效果着色器资产解析（预览/运行时侧）：Properties + Base + CGINCLUDE + Hook。
//
// 与后端 src-tauri/src/scene/shader.rs 同规则（导出产物不经 Rust，直接在前端解析
// 同一份源码；两边修改需同步）：
//   Properties → 材质面板暴露的参数（值存 .mat 的 props，键 = uniform 名）
//   Base       → 渲染分支（PBR / Unlit / Toon；决定材质用哪个 three 内置材质）
//   CGINCLUDE  → 共享工具函数（inline 到每个钩子之前）
//   Hook "X"   → 效果片段（注入到内置着色器的对应阶段，见 shaderHooks.mjs）
// 天空程序（internal/shaders/Sky*.shader）由天空材质引用，按 PreviewType=Skybox
// 标签识别（本模块一并负责，不参与效果着色器解析）。
// ---------------------------------------------------------------------------

const PROP_COLOR = "color";
const PROP_RANGE = "range";
const PROP_FLOAT = "float";
const PROP_INT = "int";
const PROP_VECTOR = "vector";
const PROP_TEXTURE = "texture";

/** Float/Int 属性的面板取值范围（Range 属性用自身声明的上下界） */
const FREE_MIN = -10000;
const FREE_MAX = 10000;

/** 全部合法钩子名 */
const ALL_HOOKS = ["Vertex", "Normal", "Diffuse", "Emissive", "Fragment"];

/** 去行尾注释（// ...；不处理块注释，与后端 strip_comment 同规则） */
function stripComment(line) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inStr = !inStr;
    if (!inStr && ch === "/" && line[i + 1] === "/") break;
    out += ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Properties（属性表）
// ---------------------------------------------------------------------------

/** 首个引号起的引号内文案 */
function quotedText(s) {
  const start = s.indexOf('"');
  if (start < 0) return null;
  const end = s.indexOf('"', start + 1);
  return end > start ? s.slice(start + 1, end) : null;
}

/** 类型声明结束括号（深度 0 上遇到的 ')' 即类型终点） */
function typeSpecEnd(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth += 1;
    else if (c === ")") {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

function numberList(s) {
  const inner = s.trim().replace(/^\(/, "").replace(/\)$/, "");
  const out = [];
  for (const part of inner.split(",")) {
    const v = parseFloat(part.trim());
    if (!Number.isFinite(v)) return null;
    out.push(v);
  }
  return out;
}

function unitByte(v) {
  return Math.round(Math.max(0, Math.min(1, v)) * 255);
}

/** Properties 行的默认值 → 按类型收敛的默认值 */
function parsePropertyDefault(kind, raw) {
  const text = String(raw ?? "").trim();
  if (kind === PROP_COLOR) {
    const list = numberList(text) ?? [1, 1, 1, 1];
    const at = (i) => unitByte(list[i] ?? 1);
    return (at(0) << 16) | (at(1) << 8) | at(2);
  }
  if (kind === PROP_VECTOR) {
    const list = numberList(text) ?? [0, 0, 0, 0];
    return [0, 1, 2, 3].map((i) => list[i] ?? 0);
  }
  if (kind === PROP_TEXTURE) return "";
  const v = parseFloat(text);
  const n = Number.isFinite(v) ? v : 0;
  return kind === PROP_INT ? Math.round(n) : n;
}

/** 单行属性声明：`_Name ("Label", Type) = Default` */
function parsePropertyLine(line) {
  const t = line.trim();
  if (!t.startsWith("_")) return null;
  const open = t.indexOf("(");
  if (open <= 0) return null;
  const key = t.slice(0, open).trim();
  if (!/^[0-9A-Za-z_]+$/.test(key)) return null;
  const label = quotedText(t.slice(open)) ?? key;
  const afterOpen = t.slice(open);
  const labelStart = afterOpen.indexOf('"');
  if (labelStart < 0) return null;
  const labelEnd = afterOpen.indexOf('"', labelStart + 1);
  if (labelEnd < 0) return null;
  let rest = afterOpen.slice(labelEnd + 1).trimStart();
  if (!rest.startsWith(",")) return null;
  rest = rest.slice(1).trimStart();
  const close = typeSpecEnd(rest);
  if (close < 0) return null;
  const ty = rest.slice(0, close).trim();
  let min = null;
  let max = null;
  let kind;
  const lower = ty.toLowerCase();
  if (lower === "color") kind = PROP_COLOR;
  else if (lower === "vector") kind = PROP_VECTOR;
  else if (lower === "2d" || lower === "texture") kind = PROP_TEXTURE;
  else if (lower.startsWith("range")) {
    const at = ty.indexOf("(");
    if (at >= 0) {
      const inner = ty.slice(at + 1).replace(/\)\s*$/, "");
      const parts = inner.split(",");
      const a = parseFloat(parts[0]);
      const b = parseFloat(parts[1]);
      if (Number.isFinite(a)) min = a;
      if (Number.isFinite(b)) max = b;
    }
    kind = PROP_RANGE;
  } else if (lower === "int") kind = PROP_INT;
  else kind = PROP_FLOAT;
  if (kind === PROP_FLOAT || kind === PROP_INT) {
    min = FREE_MIN;
    max = FREE_MAX;
  }
  let defaultRaw = rest.slice(close + 1).trimStart();
  if (defaultRaw.startsWith("=")) defaultRaw = defaultRaw.slice(1).trim();
  return { key, label, kind, min, max, default: parsePropertyDefault(kind, defaultRaw) };
}

/**
 * 取 Properties 块（花括号配平；可与关键字同行或换行）→ 属性表。
 * 只取第一个 Properties 块；同名属性只保留首个。
 */
export function extractProperties(text) {
  const props = [];
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = stripComment(lines[i]).trim();
    if (!t.startsWith("Properties")) continue;
    // 从关键字之后开始配平花括号，收集块内文本
    let depth = 0;
    let inner = "";
    let started = false;
    let j = i;
    let seg = t.slice("Properties".length);
    while (j < lines.length) {
      for (const ch of stripComment(seg)) {
        if (ch === "{") {
          depth += 1;
          started = true;
        } else if (ch === "}") {
          depth -= 1;
        } else if (started && depth > 0) {
          inner += ch;
        }
      }
      if (started && depth > 0) inner += "\n";
      if (started && depth <= 0) break;
      j += 1;
      seg = lines[j] ?? "";
    }
    for (const line of inner.split(/\r?\n/)) {
      const p = parsePropertyLine(line.trim());
      if (p && !props.some((e) => e.key === p.key)) props.push(p);
    }
    break;
  }
  return props;
}

// ---------------------------------------------------------------------------
// Base（渲染分支）与 Hook（效果片段）
// ---------------------------------------------------------------------------

/** Base 声明 → 渲染分支 key（physical/unlit/toon）；未知/缺失返回 null */
export function baseKind(base) {
  switch (String(base ?? "").trim().toLowerCase()) {
    case "pbr":
    case "physical":
    case "standard":
      return "physical";
    case "unlit":
    case "basic":
      return "unlit";
    case "toon":
      return "toon";
    default:
      return null;
  }
}

/** 渲染分支 key/Base 写法 → Base 声明值（提示文案用） */
export function kindBase(kind) {
  const resolved = baseKind(kind);
  if (resolved === "unlit") return "Unlit";
  if (resolved === "toon") return "Toon";
  return "PBR";
}

/** 分支支持的钩子（three 内置着色器的注入点差异；与后端 hook_support 一致） */
export function hookSupport(base) {
  return baseKind(base) === "unlit" ? ["Vertex", "Diffuse", "Fragment"] : ALL_HOOKS;
}

/** 该（分支, 钩子）下不可用的约定变量（Unlit 片元阶段没有 vViewPosition/法线） */
function forbiddenVars(base, hook) {
  return baseKind(base) === "unlit" && hook !== "Vertex" ? ["viewDir", "normal"] : [];
}

/** 按空白与常见标点切词（标识符词法） */
function words(s) {
  return String(s).split(/[^0-9A-Za-z_]+/).filter((w) => w.length > 0);
}

/** 标识符是否在代码中以独立单词出现 */
function mentions(text, key) {
  return words(text).includes(key);
}

/** 从引号中取文本：`Base "PBR"` → "PBR" */
function quotedValue(line, keyword) {
  const t = String(line).trim();
  if (!t.startsWith(keyword)) return null;
  let rest = t.slice(keyword.length).trimStart();
  if (!rest.startsWith('"')) return null;
  const end = rest.indexOf('"', 1);
  return end > 0 ? rest.slice(1, end) : null;
}

/** 提取 Base 声明（未声明返回空串） */
function extractBase(text) {
  const lines = String(text ?? "").split("\n");
  for (const rawLine of lines) {
    const v = quotedValue(stripComment(rawLine.replace(/\r$/, "")).trim(), "Base");
    if (v !== null) return v;
  }
  return "";
}

/** 提取 CGINCLUDE 块内容（ENDCG 结束） */
function extractInclude(text) {
  let include = "";
  let inInclude = false;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const t = stripComment(line).trim();
    if (inInclude) {
      if (t === "ENDCG") {
        inInclude = false;
        continue;
      }
      include += line + "\n";
      continue;
    }
    if (t === "CGINCLUDE") inInclude = true;
  }
  return include;
}

/** 提取所有 Hook 块（未知钩子名/分支不支持的钩子/不可用变量 → 错误） */
function extractHooks(base, text) {
  const hooks = [];
  const lines = String(text ?? "").split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const t = stripComment(lines[i]).trim();
    if (!t.startsWith("Hook")) {
      i++;
      continue;
    }
    let rest = t.slice("Hook".length).trimStart();
    if (!rest.startsWith('"')) {
      i++;
      continue;
    }
    const nameEnd = rest.indexOf('"', 1);
    if (nameEnd < 0) {
      i++;
      continue;
    }
    const rawName = rest.slice(1, nameEnd);
    const name = ALL_HOOKS.find((h) => h.toLowerCase() === rawName.trim().toLowerCase());
    if (!name) {
      return { hooks, error: `未知钩子名 "${rawName}"：合法钩子为 ${ALL_HOOKS.join(" / ")}` };
    }
    if (!hookSupport(base).includes(name)) {
      return {
        hooks,
        error: `钩子 "${name}" 不适用于 ${kindBase(base)} 分支：可用钩子为 ${hookSupport(base).join(" / ")}`,
      };
    }
    rest = rest.slice(nameEnd + 1);
    let depth = 0;
    let code = "";
    let started = false;
    const segs = [rest, ...lines.slice(i + 1)];
    for (const seg of segs) {
      for (const ch of stripComment(seg)) {
        if (ch === "{") {
          depth++;
          started = true;
        } else if (ch === "}") {
          depth--;
        } else if (started && depth > 0) {
          code += ch;
        }
      }
      if (started && depth > 0) code += "\n";
      if (started && depth <= 0) break;
    }
    const trimmed = code.trim();
    const forbidden = forbiddenVars(base, name).filter((v) => mentions(trimmed, v));
    if (forbidden.length > 0) {
      return {
        hooks,
        error: `钩子 "${name}" 在 ${kindBase(base)} 分支下不能用 ${forbidden.join(" / ")}（Unlit 没有法线，片元阶段不存在 vViewPosition）`,
      };
    }
    if (!hooks.some((h) => h.name === name)) {
      hooks.push({ name, code: trimmed });
    }
    i++;
  }
  return { hooks, error: null };
}

/**
 * 旧版着色器（重构前：按 pragma 判别的渲染分支程序，无 Base）→ 建议补的 Base。
 * 只用于「缺 Base」时的迁移提示，不参与正常解析。
 */
export function legacyBase(text) {
  const lines = String(text ?? "").split("\n");
  for (const rawLine of lines) {
    const t = stripComment(rawLine.replace(/\r$/, "")).trim();
    if (!t.startsWith("#pragma")) continue;
    const rest = t.slice("#pragma".length).trimStart();
    if (rest.startsWith("surface")) {
      const it = rest.split(/\s+/);
      const model = (it[2] ?? "").toLowerCase();
      return model === "toon" ? "Toon" : "PBR";
    }
    if (rest.startsWith("fragment") || rest.startsWith("vertex")) return "Unlit";
  }
  return "PBR";
}

/** 是否为天空程序（天空盒惯例 PreviewType=Skybox 标签） */
export function isSkyProgram(text) {
  return String(text ?? "").includes('"PreviewType"="Skybox"');
}

/**
 * 解析着色器源码 → { properties, base, include, hooks, error }。
 * 天空程序：不参与效果着色器解析（属性/钩子为空）；其他：按 Base 校验钩子。
 */
export function parseShader(text) {
  if (isSkyProgram(text)) {
    return { properties: [], base: "", include: "", hooks: [], error: null };
  }
  const properties = extractProperties(text);
  const base = extractBase(text);
  const include = extractInclude(text);
  const { hooks, error: hookErr } = extractHooks(base, text);
  let error = hookErr;
  if (!error) {
    if (!base.trim()) {
      const legacy = String(text).includes("#pragma");
      const suggested = legacyBase(text);
      error = legacy
        ? `未声明 Base：本文件是旧版着色器（按旧规则识别为 ${suggested} 分支），请补一行 Base "${suggested}"（该行决定材质走哪个渲染分支；补上后即可用 Hook 叠加效果）`
        : '未声明 Base：请在文件里补一行 Base "PBR"（或 "Unlit" / "Toon"），决定材质走哪个渲染分支';
    } else if (!baseKind(base)) {
      error = `未知 Base "${base}"：可用 PBR / Unlit / Toon`;
    }
  }
  return { properties, base, include, hooks, error };
}

/** 着色器源码 → 渲染分支 key（physical/unlit/toon/skyprocedural/skycube） */
export function shaderKind(text) {
  if (!isSkyProgram(text)) return baseKind(extractBase(text));
  return String(text).includes("samplerCUBE") ? "skycube" : "skyprocedural";
}

/** 着色器源码 → Shader 指令名（去组前缀）；无指令行返回 null */
export function shaderName(text) {
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("Shader ") && !t.startsWith("shader ")) continue;
    const rest = t.slice("Shader ".length).trimStart();
    if (!rest.startsWith('"')) continue;
    const end = rest.indexOf('"', 1);
    if (end > 0) {
      const segs = rest.slice(1, end).split("/");
      return segs[segs.length - 1].trim();
    }
  }
  return null;
}
