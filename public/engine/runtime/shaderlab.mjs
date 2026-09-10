// ---------------------------------------------------------------------------
// 自定义着色器（.shader kind=custom）源码解析与程序组装（网页运行时侧）。
//
// 与后端 src-tauri/src/scene/shader.rs 同规则（导出产物不经 Rust，直接在前端
// 解析同一份源码；两边修改需同步）：
//   - Properties → 属性表（材质面板字段 + 自动 uniform 声明）
//   - CGINCLUDE  → 共享声明，两个阶段都拼入
//   - CGPROGRAM  → 顶点/片元代码块（#pragma vertex/fragment 指定入口函数）
//   - 渲染状态   → Tags/指令行（Queue/RenderType/ZWrite/Cull）
// 组装结果为 three ShaderMaterial 的顶点/片元源码。
// 判定：含 CGINCLUDE 块或 ≥2 个 CGPROGRAM 块 → 自定义着色器。
// ---------------------------------------------------------------------------

const PROP_COLOR = "color";
const PROP_RANGE = "range";
const PROP_FLOAT = "float";
const PROP_INT = "int";
const PROP_VECTOR = "vector";
const PROP_TEXTURE = "texture";

/** 内置时间 uniform（秒）；由渲染循环经 tickShaderTime 推进 */
export const TIME_UNIFORM = "_Time";

const FREE_MIN = -10000;
const FREE_MAX = 10000;

const GLSL_TYPES = [
  "sampler2D",
  "samplerCube",
  "sampler3D",
  "sampler2DShadow",
  "float",
  "int",
  "bool",
  "vec2",
  "vec3",
  "vec4",
  "ivec2",
  "ivec3",
  "ivec4",
  "mat2",
  "mat3",
  "mat4",
];

/** 去行注释（仅用于指令/标签匹配；代码块保留原文） */
function stripComment(line) {
  const i = line.indexOf("//");
  return i >= 0 ? line.slice(0, i) : line;
}

/** 按空白与常见标点切词 */
function words(s) {
  return s.split(/[^0-9A-Za-z_]+/).filter((w) => w.length > 0);
}

function mentions(text, key) {
  return words(text).includes(key);
}

/** 是否为自定义着色器源码（CGINCLUDE 块或 ≥2 个 CGPROGRAM 块） */
export function isCustomShader(text) {
  const src = String(text ?? "");
  let programs = 0;
  for (const line of src.split(/\r?\n/)) {
    const t = stripComment(line).trim();
    if (t === "CGINCLUDE") return true;
    if (t === "CGPROGRAM") programs += 1;
  }
  return programs >= 2;
}

/** 标签/指令取值：`"Key"="Value"` 或 `Key Value` 两种写法 */
function stateValue(line, key) {
  const quoted = `"${key}"`;
  const at = line.indexOf(quoted);
  if (at >= 0) {
    let rest = line.slice(at + quoted.length).trimStart();
    if (!rest.startsWith("=")) return null;
    rest = rest.slice(1).trimStart();
    if (!rest.startsWith('"')) return null;
    const end = rest.indexOf('"', 1);
    return end > 0 ? rest.slice(1, end).trim() : null;
  }
  const t = line.trimStart();
  const head = t.split(/\s+/)[0] ?? "";
  if (head.toLowerCase() !== key.toLowerCase()) return null;
  return t.slice(head.length).trim().split(/\s+/)[0] ?? null;
}

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

/** 取 Properties 块（花括号配平；可与关键字同行或换行）→ 属性表 */
function extractProperties(text) {
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

function braceBalance(s) {
  let n = 0;
  for (const c of s) {
    if (c === "{") n += 1;
    else if (c === "}") n -= 1;
  }
  return n;
}

/** 扫描源码 → 共享代码 + 代码块 + 渲染状态（Properties 另行提取） */
function scan(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  let state = "top";
  let buf = "";
  let stage = null;
  let include = "";
  const blocks = [];
  const render = { transparent: false, depthWrite: true, side: "front" };
  let propDepth = 0;
  for (const raw of lines) {
    const t = stripComment(raw).trim();
    if (state === "program" || state === "include") {
      if (t === "ENDCG") {
        if (state === "program") blocks.push({ stage, code: buf });
        else include += buf;
        state = "top";
        stage = null;
        buf = "";
        continue;
      }
      if (state === "program" && stage === null && t.startsWith("#pragma")) {
        const rest = t.slice("#pragma".length).trimStart();
        if (rest.startsWith("vertex")) stage = "vertex";
        else if (rest.startsWith("fragment")) stage = "fragment";
      }
      buf += raw + "\n";
      continue;
    }
    // Properties 块整块跳过（属性由 extractProperties 解析）
    if (propDepth > 0) {
      propDepth += braceBalance(t);
      continue;
    }
    const queue = stateValue(t, "Queue") ?? stateValue(t, "RenderType");
    if (queue && queue.toLowerCase() === "transparent") render.transparent = true;
    const zw = stateValue(t, "ZWrite");
    if (zw) render.depthWrite = zw.toLowerCase() !== "off";
    const cull = stateValue(t, "Cull");
    if (cull) {
      const lv = cull.toLowerCase();
      render.side = lv === "off" ? "double" : lv === "front" ? "back" : "front";
    }
    const head = t.split(/\s+/)[0] ?? "";
    if (head === "CGINCLUDE") {
      state = "include";
      buf = "";
      continue;
    }
    if (head === "CGPROGRAM") {
      state = "program";
      buf = "";
      stage = null;
      continue;
    }
    if (t.startsWith("Properties")) {
      const balance = braceBalance(t.slice("Properties".length));
      if (balance > 0) propDepth = balance;
      continue;
    }
  }
  return { include, blocks, render };
}

/** 顶点/片元块下标：优先 pragma 标记，无标记按块顺序（第一块顶点、第二块片元） */
function stageBlocks(blocks) {
  if (blocks.length < 2) return null;
  const v = blocks.findIndex((b) => b.stage === "vertex");
  const f = blocks.findIndex((b) => b.stage === "fragment");
  if (v >= 0 && f >= 0 && v !== f) return [v, f];
  if (v >= 0) return [v, v === 0 ? 1 : 0];
  if (f >= 0) return [f === 0 ? 1 : 0, f];
  return [0, 1];
}

/** 去掉入口 pragma 行（`#pragma vertex/fragment` 是给引擎看的标记，不是 GLSL） */
function stripEntryPragmas(code) {
  let out = "";
  for (const line of String(code).split(/\r?\n/)) {
    const t = stripComment(line).trimStart();
    if (t.startsWith("#pragma")) {
      const rest = t.slice("#pragma".length).trimStart();
      if (rest.startsWith("vertex") || rest.startsWith("fragment")) continue;
    }
    out += line + "\n";
  }
  return out;
}

/** 入口函数名（`#pragma vertex <name>`） */
function pragmaEntry(block, stage) {
  for (const line of String(block).split(/\r?\n/)) {
    const t = stripComment(line).trim();
    if (!t.startsWith("#pragma")) continue;
    const rest = t.slice("#pragma".length).trimStart();
    if (!rest.startsWith(stage)) continue;
    const after = rest.slice(stage.length).trimStart();
    if (!after || after.startsWith("(")) continue;
    const name = after.split(/\s+/)[0];
    if (name) return name;
  }
  return null;
}

/** 代码块是否自带 main（自带则不再包装入口函数） */
function hasMain(block) {
  const w = words(String(block));
  return w.some((word, i) => word === "main" && i > 0 && w[i - 1].includes("void"));
}

/** 入口函数返回值：true（vec4 → 写 gl_FragColor）/ false（void）/ null（未找到） */
function entryReturnsValue(block, entry) {
  let found = null;
  for (const line of String(block).split(/\r?\n/)) {
    const w = words(stripComment(line));
    w.forEach((word, i) => {
      if (word !== entry || i === 0) return;
      const head = w[i - 1];
      if (head === "vec4" || head === "fixed4" || head === "half4") found = true;
      else if (head === "void") found = false;
    });
  }
  return found;
}

/** 该标识符是否已由源码手工声明（手工声明优先，引擎不重复声明） */
function declaredInSource(code, key) {
  return String(code)
    .split(/\r?\n/)
    .some((line) => {
      const w = words(stripComment(line));
      const tyAt = w[0] === "uniform" ? 1 : 0;
      const ty = w[tyAt];
      if (!GLSL_TYPES.includes(ty)) return false;
      return w[tyAt + 1] === key;
    });
}

function uniformDecl(prop) {
  const ty =
    prop.kind === PROP_COLOR || prop.kind === PROP_VECTOR
      ? "vec4"
      : prop.kind === PROP_TEXTURE
        ? "sampler2D"
        : "float";
  return `uniform ${ty} ${prop.key};\n`;
}

/** 阶段专属 uniform 声明（属性 + _Time；只声明该阶段引用且未手工声明的项） */
function stageDeclarations(properties, stageCode) {
  let out = "";
  for (const prop of properties) {
    if (stageCode.includes(prop.key) && !declaredInSource(stageCode, prop.key)) {
      out += uniformDecl(prop);
    }
  }
  if (mentions(stageCode, TIME_UNIFORM) && !declaredInSource(stageCode, TIME_UNIFORM)) {
    out += `uniform float ${TIME_UNIFORM};\n`;
  }
  return out;
}

function stageHeader(rel, stage) {
  return `// TVE 自定义着色器: ${rel}（${stage}阶段 · CGINCLUDE/CGPROGRAM 拼接产物）\n`;
}

/** 片元入口包装：返回 vec4 → 写 gl_FragColor；返回 void → 直接调用。
 * 两种情况都补上 three 的输出阶段（色调映射 + 输出色彩空间转换）——内置材质由
 * three 的 shader chunk 完成，裸 ShaderMaterial 不会自动应用（与后端 shader.rs 同规则）。 */
function fragmentMain(entry, returnsValue) {
  const body = returnsValue ? `    gl_FragColor = ${entry}();` : `    ${entry}();`;
  return `void main() {\n${body}\n    #include <tonemapping_fragment>\n    #include <colorspace_fragment>\n}\n`;
}

/**
 * 解析自定义着色器源码 → { properties, program, error }。
 * program = { vertex, fragment, transparent, depthWrite, side }；不可组装时为 null + error。
 */
export function parseCustomShader(text, rel) {
  const properties = extractProperties(text);
  const { include, blocks, render } = scan(text);
  const idx = stageBlocks(blocks);
  if (!idx) {
    return {
      properties,
      program: null,
      error:
        "缺少顶点/片元 CGPROGRAM 块：自定义着色器需要两个 CGPROGRAM 块（#pragma vertex / #pragma fragment）",
    };
  }
  const vb = blocks[idx[0]];
  const fb = blocks[idx[1]];

  const vBody = include + stripEntryPragmas(vb.code);
  const vMain = hasMain(vb.code)
    ? ""
    : `void main() { ${pragmaEntry(vb.code, "vertex") ?? "vert"}(); }\n`;
  const vertex = stageHeader(rel, "顶点") + stageDeclarations(properties, vBody) + vBody + vMain;

  const fBody = include + stripEntryPragmas(fb.code);
  let fMain = "";
  if (!hasMain(fb.code)) {
    const entry = pragmaEntry(fb.code, "fragment") ?? "frag";
    const ret = entryReturnsValue(fb.code, entry);
    if (ret === null) {
      return {
        properties,
        program: null,
        error: `未找到片元入口函数 ${entry}()：请在片元 CGPROGRAM 块内定义它，或让 #pragma fragment 指向实际函数名`,
      };
    }
    fMain = fragmentMain(entry, ret);
  }
  const fragment = stageHeader(rel, "片元") + stageDeclarations(properties, fBody) + fBody + fMain;

  return {
    properties,
    program: {
      vertex,
      fragment,
      transparent: render.transparent,
      depthWrite: render.depthWrite,
      side: render.side,
    },
    error: null,
  };
}
