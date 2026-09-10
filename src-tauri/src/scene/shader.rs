// ---------------------------------------------------------------------------
// 自定义着色器（.shader kind = custom）源码解析与程序组装（后端权威）。
//
// 与内置渲染分支（physical/unlit/toon 按 pragma 映射到 three 现成材质）不同，
// 自定义着色器的源码会被真正编译：引擎把源码中的三部分拼成 three
// ShaderMaterial 的顶点/片元着色器：
//   - Properties  → 材质面板字段 + 自动 uniform 声明（参数值存于 .mat 的 props）
//   - CGINCLUDE   → 共享声明（varying / 工具函数），两个阶段都会拼入
//   - CGPROGRAM   → 顶点/片元各自的代码块（#pragma vertex/fragment 指定入口函数）
// 渲染状态由标签或指令行声明（Queue/ZWrite/Cull），组装结果的
// transparent/depthWrite/side 供引擎写入 ShaderMaterial。
//
// 与 public/engine/runtime/shaderlab.mjs（导出产物内的网页运行时）保持同规则：
// 网页预览/构建产物不经后端，直接在前端按同一语义解析同一份源码，两边需同步修改。
// ---------------------------------------------------------------------------

use serde::Serialize;
use serde_json::{json, Value};

/// 着色器属性类型：颜色（vec4，a=1）
pub const PROP_COLOR: &str = "color";
/// 着色器属性类型：范围数值（Range(min, max) → float）
pub const PROP_RANGE: &str = "range";
/// 着色器属性类型：自由数值（Float → float）
pub const PROP_FLOAT: &str = "float";
/// 着色器属性类型：整数（Int → float，面板取整）
pub const PROP_INT: &str = "int";
/// 着色器属性类型：四元向量（Vector → vec4）
pub const PROP_VECTOR: &str = "vector";
/// 着色器属性类型：贴图（2D → sampler2D，按 sRGB 加载）
pub const PROP_TEXTURE: &str = "texture";

/// 引擎注入的内置 uniform：运行秒数（编辑器 = 引擎运行时长，网页产物 = 加载后时长）
pub const TIME_UNIFORM: &str = "_Time";

/// Float/Int 属性的面板取值范围（Range 属性用自身声明的上下界）
const FREE_MIN: f64 = -10000.0;
const FREE_MAX: f64 = 10000.0;

/// GLSL 标量/向量/采样器类型名（判断手工 uniform 声明用）
const GLSL_TYPES: [&str; 16] = [
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

/// 着色器属性（Properties 块的一项）→ 材质面板字段 + 自动 uniform 声明
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShaderPropertyDef {
    /// 属性名（= uniform 名，惯例以 _ 开头）
    pub key: String,
    /// 显示名（Properties 行引号内文案；缺省回退 key）
    pub label: String,
    /// 属性类型（color/range/float/int/vector/texture）
    pub kind: String,
    /// 面板下界（range 用声明值；float/int 为宽松范围；颜色/贴图为 None）
    pub min: Option<f64>,
    /// 面板上界（同上）
    pub max: Option<f64>,
    /// 默认值：color → RGB hex 数字、range/float/int → 数字、vector → [x,y,z,w]、texture → ""
    pub default: Value,
}

/// 组装后的自定义着色器程序（three ShaderMaterial 可直接使用）
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomShaderProgram {
    /// 顶点着色器源码（uniform 声明 + CGINCLUDE + 顶点块 + main 包装）
    pub vertex: String,
    /// 片元着色器源码（uniform 声明 + CGINCLUDE + 片元块 + main 包装）
    pub fragment: String,
    /// 半透明混合（Tags 声明 Queue/RenderType = Transparent）
    pub transparent: bool,
    /// 深度写入（ZWrite Off 关闭；半透明特效常用）
    pub depth_write: bool,
    /// 面剔除（Cull Off → double / Cull Front → back / Cull Back 或未声明 → front）
    pub side: String,
}

/// 解析结果（properties 恒可用，program 与 error 二选一）
#[derive(Clone, Debug)]
pub struct CustomShaderParse {
    pub properties: Vec<ShaderPropertyDef>,
    pub program: Option<CustomShaderProgram>,
    pub error: Option<String>,
}

/// 去掉行注释（// …）后的内容（仅用于指令/标签匹配；代码块保留原文）
fn strip_comment(line: &str) -> &str {
    match line.find("//") {
        Some(i) => &line[..i],
        None => line,
    }
}

/// 按空白与常见标点切词（标识符词法）
fn words(s: &str) -> Vec<&str> {
    s.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty())
        .collect()
}

/// 标识符是否在源码中以独立单词出现
fn mentions(text: &str, key: &str) -> bool {
    words(text).iter().any(|w| *w == key)
}

/// 是否为自定义着色器源码：含 CGINCLUDE 块（共享代码）或 ≥2 个 CGPROGRAM 块
/// （顶点/片元分块）。内置分支模板（surface / 单块顶点片元）不满足此条件。
pub(crate) fn is_custom_shader(text: &str) -> bool {
    let mut programs = 0;
    for line in text.lines() {
        let t = strip_comment(line).trim();
        if t == "CGINCLUDE" {
            return true;
        }
        if t == "CGPROGRAM" {
            programs += 1;
        }
    }
    programs >= 2
}

/// 标签/指令行的取值：接受 `"Key"="Value"`（SubShader Tags 写法）与
/// `Key Value`（Pass 指令写法）—— 两种写法都常见，这里一并识别。
fn state_value(line: &str, key: &str) -> Option<String> {
    let quoted = format!("\"{key}\"");
    if let Some(i) = line.find(&quoted) {
        let rest = line[i + quoted.len()..].trim_start();
        let rest = rest.strip_prefix('=')?.trim_start();
        let rest = rest.strip_prefix('"')?;
        let end = rest.find('"')?;
        return Some(rest[..end].trim().to_string());
    }
    let t = line.trim_start();
    let head = t.split_whitespace().next()?;
    if !head.eq_ignore_ascii_case(key) {
        return None;
    }
    t[head.len()..].trim().split_whitespace().next().map(str::to_string)
}

/// 从首个引号起取引号内文案
fn quoted_text(s: &str) -> Option<String> {
    let start = s.find('"')?;
    let rest = &s[start + 1..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// 类型声明结束括号：`Color) = …` / `Range(0, 5)) = …` 都返回类型后那个 ')' 的下标
/// （深度 0 上遇到的 ')' 即类型声明终点）
fn type_spec_end(s: &str) -> Option<usize> {
    let mut depth = 0i32;
    for (i, c) in s.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => {
                if depth == 0 {
                    return Some(i);
                }
                depth -= 1;
            }
            _ => {}
        }
    }
    None
}

/// 数值列表 `(1, 0.5, 0, 1)` → Vec<f64>
fn number_list(s: &str) -> Option<Vec<f64>> {
    let inner = s.trim().trim_start_matches('(').trim_end_matches(')');
    inner.split(',').map(|part| part.trim().parse::<f64>().ok()).collect()
}

fn unit_byte(v: f64) -> i64 {
    (v.clamp(0.0, 1.0) * 255.0).round() as i64
}

/// Properties 行的默认值 → 按类型收敛的默认值
fn parse_property_default(kind: &str, raw: &str) -> Value {
    let raw = raw.trim();
    match kind {
        PROP_COLOR => {
            let list = number_list(raw).unwrap_or_else(|| vec![1.0, 1.0, 1.0, 1.0]);
            let at = |i: usize| unit_byte(*list.get(i).unwrap_or(&1.0));
            json!((at(0) << 16) | (at(1) << 8) | at(2))
        }
        PROP_VECTOR => {
            let list = number_list(raw).unwrap_or_else(|| vec![0.0, 0.0, 0.0, 0.0]);
            Value::Array((0..4).map(|i| json!(list.get(i).copied().unwrap_or(0.0))).collect())
        }
        PROP_TEXTURE => json!(""),
        PROP_INT => json!(raw.parse::<f64>().unwrap_or(0.0).round()),
        _ => json!(raw.parse::<f64>().unwrap_or(0.0)),
    }
}

/// 解析单行属性声明：`_Name ("Label", Type) = Default`
fn parse_property_line(line: &str) -> Option<ShaderPropertyDef> {
    let t = line.trim();
    if !t.starts_with('_') {
        return None;
    }
    let open = t.find('(')?;
    let key = t[..open].trim().to_string();
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    let label = quoted_text(&t[open..]).unwrap_or_else(|| key.clone());
    // 标签引号之后：`, Type) = Default`
    let after_open = &t[open..];
    let label_start = after_open.find('"')?;
    let label_end = after_open[label_start + 1..].find('"')? + label_start + 1;
    let rest = after_open[label_end + 1..].trim_start().strip_prefix(',')?.trim_start();
    let close = type_spec_end(rest)?;
    let ty = rest[..close].trim();
    let mut min = None;
    let mut max = None;
    let kind = if ty.eq_ignore_ascii_case("color") {
        PROP_COLOR
    } else if ty.eq_ignore_ascii_case("vector") {
        PROP_VECTOR
    } else if ty.eq_ignore_ascii_case("2d") || ty.eq_ignore_ascii_case("texture") {
        PROP_TEXTURE
    } else if ty.to_ascii_lowercase().starts_with("range") {
        if let Some(at) = ty.find('(') {
            let inner = ty[at + 1..].trim_end_matches(')');
            let mut it = inner.split(',');
            min = it.next().and_then(|s| s.trim().parse::<f64>().ok());
            max = it.next().and_then(|s| s.trim().parse::<f64>().ok());
        }
        PROP_RANGE
    } else if ty.eq_ignore_ascii_case("int") {
        PROP_INT
    } else {
        PROP_FLOAT
    };
    if kind == PROP_FLOAT || kind == PROP_INT {
        min = Some(FREE_MIN);
        max = Some(FREE_MAX);
    }
    let default_raw = rest[close + 1..].trim_start().strip_prefix('=').unwrap_or("").trim();
    Some(ShaderPropertyDef {
        key,
        label,
        kind: kind.to_string(),
        min,
        max,
        default: parse_property_default(kind, default_raw),
    })
}

/// 该标识符是否已由源码手工声明（`uniform vec4 _X;` / `sampler2D _X;` …）——
/// 手工声明优先，引擎不再重复声明（重复声明是 GLSL 编译错误）。
fn declared_in_source(code: &str, key: &str) -> bool {
    code.lines().any(|line| {
        let t = strip_comment(line);
        let w = words(t);
        let (ty_at, name_at) = if w.first() == Some(&"uniform") { (1, 2) } else { (0, 1) };
        let Some(ty) = w.get(ty_at) else { return false };
        if !GLSL_TYPES.contains(ty) {
            return false;
        }
        // 声明名后可能紧跟 ';' / '=' / '[' —— 切词后取名字段即可
        w.get(name_at).is_some_and(|name| *name == key)
    })
}

/// 属性 → uniform 声明行（颜色/向量 → vec4，贴图 → sampler2D，其余 → float）
fn uniform_decl(prop: &ShaderPropertyDef) -> String {
    let ty = match prop.kind.as_str() {
        PROP_COLOR | PROP_VECTOR => "vec4",
        PROP_TEXTURE => "sampler2D",
        _ => "float",
    };
    format!("uniform {ty} {};\n", prop.key)
}

/// 阶段专属 uniform 声明集合（属性 + _Time）：只声明该阶段引用且未手工声明的项
/// （未被引用的 uniform 不声明，避免顶点阶段占用采样器单元）
fn stage_declarations(properties: &[ShaderPropertyDef], stage_code: &str) -> String {
    let mut out = String::new();
    for prop in properties {
        if mentions(stage_code, &prop.key) && !declared_in_source(stage_code, &prop.key) {
            out.push_str(&uniform_decl(prop));
        }
    }
    if mentions(stage_code, TIME_UNIFORM) && !declared_in_source(stage_code, TIME_UNIFORM) {
        out.push_str(&format!("uniform float {TIME_UNIFORM};\n"));
    }
    out
}

/// 片元入口包装：返回 vec4 → 写 gl_FragColor；返回 void → 直接调用。
/// 两种情况都补上 three 的输出阶段（色调映射 + 输出色彩空间转换）——内置材质由
/// three 的 shader chunk 完成，裸 ShaderMaterial 不会自动应用；补上后自定义着色器
/// 的面板颜色/亮度与内置材质一致（HDR 工程的 ACES 色调映射同样生效）。
fn fragment_main(entry: &str, returns_value: bool) -> String {
    let body = if returns_value {
        format!("    gl_FragColor = {entry}();")
    } else {
        format!("    {entry}();")
    };
    format!(
        "void main() {{\n{body}\n    #include <tonemapping_fragment>\n    #include <colorspace_fragment>\n}}\n"
    )
}

/// 入口函数返回值：Vec4 → true（片元包装成 gl_FragColor 赋值）、void → false、
/// 未找到 → None（报错用）。按 `vec4 frag()` 这类签名识别。
fn entry_returns_value(block: &str, entry: &str) -> Option<bool> {
    let mut found: Option<bool> = None;
    for line in block.lines() {
        let w = words(strip_comment(line));
        for (i, word) in w.iter().enumerate() {
            if *word != entry || i == 0 {
                continue;
            }
            match w[i - 1] {
                "vec4" | "fixed4" | "half4" => found = Some(true),
                "void" => found = Some(false),
                _ => {}
            }
        }
    }
    found
}

/// 代码块是否自带 main（自带则引擎不再包装入口函数，高级用法直接写 void main）
fn has_main(block: &str) -> bool {
    let w = words(block);
    w.iter().enumerate().any(|(i, word)| {
        *word == "main" && i > 0 && (w[i - 1] == "void" || w[i - 1].contains("void"))
    })
}

/// 取 `#pragma vertex <name>` / `#pragma fragment <name>` 指定的入口函数名
fn pragma_entry(block: &str, stage: &str) -> Option<String> {
    for line in block.lines() {
        let t = strip_comment(line).trim();
        let Some(rest) = t.strip_prefix("#pragma") else { continue };
        let rest = rest.trim_start();
        let Some(rest) = rest.strip_prefix(stage) else { continue };
        let rest = rest.trim_start();
        if rest.is_empty() || rest.starts_with('(') {
            continue;
        }
        if let Some(name) = rest.split_whitespace().next() {
            return Some(name.to_string());
        }
    }
    None
}

/// 取 Properties 块文本（`Properties` 后花括号配平的内容；块可与关键字同行或换行），
/// 并解析为属性表。只取第一个 Properties 块。
fn extract_properties(text: &str) -> Vec<ShaderPropertyDef> {
    let mut props: Vec<ShaderPropertyDef> = Vec::new();
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        let t = strip_comment(line).trim();
        let Some(rest) = t.strip_prefix("Properties") else { continue };
        let mut depth = 0i32;
        let mut inner = String::new();
        let mut started = false;
        for seg in std::iter::once(rest).chain(lines.by_ref()) {
            for ch in strip_comment(seg).chars() {
                match ch {
                    '{' => {
                        depth += 1;
                        started = true;
                    }
                    '}' => depth -= 1,
                    _ => {
                        if started && depth > 0 {
                            inner.push(ch);
                        }
                    }
                }
            }
            // 每行一个换行，保证属性按行解析
            if started && depth > 0 {
                inner.push('\n');
            }
            if started && depth <= 0 {
                break;
            }
        }
        for line2 in inner.lines() {
            if let Some(p) = parse_property_line(line2.trim()) {
                if !props.iter().any(|e| e.key == p.key) {
                    props.push(p);
                }
            }
        }
        break;
    }
    props
}

/// 收集到的代码块（CGINCLUDE 或某个 CGPROGRAM）
struct CodeBlock {
    /// 阶段标记（#pragma vertex / #pragma fragment）；无 pragma 时为 None
    stage: Option<&'static str>,
    code: String,
}

/// 去掉入口 pragma 行（`#pragma vertex/fragment <name>` 是给引擎看的标记，
/// 不是 GLSL 语法）：组装进着色器前剔除，其余 pragma（如 three 的 unroll）保留
fn strip_entry_pragmas(code: &str) -> String {
    let mut out = String::new();
    for line in code.lines() {
        let t = strip_comment(line).trim_start();
        if let Some(rest) = t.strip_prefix("#pragma") {
            let rest = rest.trim_start();
            if rest.starts_with("vertex") || rest.starts_with("fragment") {
                continue;
            }
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// 顶点/片元块的下标：优先取 pragma 标记的块；无标记时按块顺序（第一块顶点、第二块片元）
fn stage_blocks(blocks: &[CodeBlock]) -> Option<(usize, usize)> {
    if blocks.len() < 2 {
        return None;
    }
    let vertex = blocks.iter().position(|b| b.stage == Some("vertex"));
    let fragment = blocks.iter().position(|b| b.stage == Some("fragment"));
    match (vertex, fragment) {
        (Some(v), Some(f)) if v != f => Some((v, f)),
        (Some(v), None) => Some((v, if v == 0 { 1 } else { 0 })),
        (None, Some(f)) => Some((if f == 0 { 1 } else { 0 }, f)),
        _ => Some((0, 1)),
    }
}

/// 渲染状态（缺省：不透明、写深度、剔除背面）
struct RenderState {
    transparent: bool,
    depth_write: bool,
    side: &'static str,
}

/// 扫描源码 → 共享代码 + 代码块 + 渲染状态（Properties 块另行提取）
fn scan(text: &str) -> (String, Vec<CodeBlock>, RenderState) {
    #[derive(PartialEq)]
    enum State {
        Top,
        Include,
        Program,
    }
    let mut include = String::new();
    let mut blocks: Vec<CodeBlock> = Vec::new();
    let mut render = RenderState { transparent: false, depth_write: true, side: "front" };
    let mut state = State::Top;
    let mut buf = String::new();
    let mut stage: Option<&'static str> = None;
    /// Properties 块内的行跳过计数（花括号未配平前不看指令/标签）
    let mut prop_depth = 0i32;

    for raw in text.lines() {
        let t = strip_comment(raw).trim();
        match state {
            State::Program | State::Include => {
                if t == "ENDCG" {
                    let code = std::mem::take(&mut buf);
                    if state == State::Program {
                        blocks.push(CodeBlock { stage, code });
                    } else {
                        include.push_str(&code);
                    }
                    state = State::Top;
                    stage = None;
                    continue;
                }
                if state == State::Program && stage.is_none() {
                    if let Some(rest) = t.strip_prefix("#pragma") {
                        let rest = rest.trim_start();
                        if rest.starts_with("vertex") {
                            stage = Some("vertex");
                        } else if rest.starts_with("fragment") {
                            stage = Some("fragment");
                        }
                    }
                }
                buf.push_str(raw);
                buf.push('\n');
                continue;
            }
            State::Top => {}
        }

        // Properties 块：整块跳过（属性由 extract_properties 单独解析）
        if prop_depth > 0 {
            prop_depth += brace_balance(t);
            continue;
        }

        // 渲染状态：标签或指令行两种写法
        if let Some(v) = state_value(t, "Queue").or_else(|| state_value(t, "RenderType")) {
            if v.eq_ignore_ascii_case("transparent") {
                render.transparent = true;
            }
        }
        if let Some(v) = state_value(t, "ZWrite") {
            render.depth_write = !v.eq_ignore_ascii_case("off");
        }
        if let Some(v) = state_value(t, "Cull") {
            render.side = match v.to_ascii_lowercase().as_str() {
                "off" => "double",
                "front" => "back",
                _ => "front",
            };
        }

        let head = t.split_whitespace().next().unwrap_or("");
        if head == "CGINCLUDE" {
            state = State::Include;
            buf.clear();
            continue;
        }
        if head == "CGPROGRAM" {
            state = State::Program;
            buf.clear();
            stage = None;
            continue;
        }
        if t.starts_with("Properties") {
            // 块内文本自此开始，配平后再回到 Top（单行块一次配平即结束）
            let rest = &t["Properties".len()..];
            let balance = brace_balance(rest);
            if balance > 0 {
                prop_depth = balance;
            }
            continue;
        }
    }
    (include, blocks, render)
}

/// 花括号净增量（'}' 计负）
fn brace_balance(s: &str) -> i32 {
    s.chars().fold(0, |acc, c| match c {
        '{' => acc + 1,
        '}' => acc - 1,
        _ => acc,
    })
}

/// 组装头部注释（编译报错时能看出是哪个资产的哪个阶段）
fn stage_header(rel: &str, stage: &str) -> String {
    format!("// TVE 自定义着色器: {rel}（{stage}阶段 · CGINCLUDE/CGPROGRAM 拼接产物，报错行号含本头部偏移）\n")
}

/// 解析自定义着色器源码 → 属性表 + 组装后的程序（不可组装时给出 error 说明）。
/// rel 仅用于组装结果头部注释。
pub fn parse_custom_shader(text: &str, rel: &str) -> CustomShaderParse {
    let properties = extract_properties(text);
    let (include, blocks, render) = scan(text);
    let Some((vi, fi)) = stage_blocks(&blocks) else {
        return CustomShaderParse {
            properties,
            program: None,
            error: Some(
                "缺少顶点/片元 CGPROGRAM 块：自定义着色器需要两个 CGPROGRAM 块（#pragma vertex / #pragma fragment）"
                    .to_string(),
            ),
        };
    };
    let (vb, fb) = (&blocks[vi], &blocks[fi]);

    let v_body = format!("{include}{}", strip_entry_pragmas(&vb.code));
    let v_main = if has_main(&vb.code) {
        String::new()
    } else {
        let entry = pragma_entry(&vb.code, "vertex").unwrap_or_else(|| "vert".to_string());
        format!("void main() {{ {entry}(); }}\n")
    };
    let vertex = format!(
        "{}{}{}{}",
        stage_header(rel, "顶点"),
        stage_declarations(&properties, &v_body),
        v_body,
        v_main
    );

    let f_body = format!("{include}{}", strip_entry_pragmas(&fb.code));
    let f_main = if has_main(&fb.code) {
        // 自带 main：不做包装（输出色彩空间/色调映射由作者自行处理）
        String::new()
    } else {
        let entry = pragma_entry(&fb.code, "fragment").unwrap_or_else(|| "frag".to_string());
        match entry_returns_value(&fb.code, &entry) {
            Some(ret) => fragment_main(&entry, ret),
            None => {
                return CustomShaderParse {
                    properties,
                    program: None,
                    error: Some(format!(
                        "未找到片元入口函数 {entry}()：请在片元 CGPROGRAM 块内定义它，或让 #pragma fragment 指向实际函数名"
                    )),
                }
            }
        }
    };
    let fragment = format!(
        "{}{}{}{}",
        stage_header(rel, "片元"),
        stage_declarations(&properties, &f_body),
        f_body,
        f_main
    );

    CustomShaderParse {
        properties,
        program: Some(CustomShaderProgram {
            vertex,
            fragment,
            transparent: render.transparent,
            depth_write: render.depth_write,
            side: render.side.to_string(),
        }),
        error: None,
    }
}

/// 新建自定义着色器资产的模板（可渲染的起步示例：颜色 × 菲涅尔边缘光 × 呼吸脉冲）
pub const CUSTOM_SHADER_TEMPLATE: &str = r##"// TVE 自定义着色器（GLSL 顶点/片元程序，kind = custom）
// 引擎把这几个块拼成 three ShaderMaterial 的顶点/片元着色器：
//   CGINCLUDE → 共享声明（varying / 工具函数）；两个阶段都会拼入，勿在其中使用阶段专属内置变量
//   CGPROGRAM + #pragma vertex   → 顶点块：在 void vert() 里写 gl_Position
//   CGPROGRAM + #pragma fragment → 片元块：在 vec4 frag() 里返回颜色
// Properties 的每一项由引擎自动声明为 uniform（值来自挂载的材质 .mat，属性面板可调）：
//   Color → vec4（a=1，面板取色） / Range(min, max) → float（面板带上下界）
//   Float、Int → float（面板范围 ±10000） / Vector → vec4（四个数值）
//   2D → sampler2D（面板选贴图资产，按 sRGB 颜色空间加载）
// 内置 uniform/变量（无需声明，可直接使用）：
//   _Time（运行秒数）、modelMatrix / modelViewMatrix / projectionMatrix / viewMatrix /
//   normalMatrix / cameraPosition，以及顶点属性 position / normal / uv
// 渲染状态（可选，缺省 = 不透明、写深度、剔除背面）：
//   Tags { "Queue"="Transparent" } → 半透明混合     Tags { "ZWrite"="Off" } → 关闭深度写入
//   Tags { "Cull"="Off" } → 双面渲染                Cull Front → 只渲染背面
Shader "{NAME}"
{
    Properties
    {
        _Color ("Base Color", Color) = (1, 1, 1, 1)
        _RimColor ("Rim Color", Color) = (0.35, 0.65, 1, 1)
        _Speed ("Pulse Speed", Range(0, 4)) = 1
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" }

        CGINCLUDE
        // 共享代码：varying 由顶点块写入、片元块读取
        varying vec2 vUv;
        varying vec3 vNormalW;
        varying vec3 vViewDirW;
        ENDCG

        CGPROGRAM
        #pragma vertex vert
        void vert()
        {
            vUv = uv;
            vNormalW = normalize(mat3(modelMatrix) * normal);
            vec4 world = modelMatrix * vec4(position, 1.0);
            vViewDirW = normalize(cameraPosition - world.xyz);
            gl_Position = projectionMatrix * viewMatrix * world;
        }
        ENDCG

        CGPROGRAM
        #pragma fragment frag
        // 需要贴图：在 Properties 中声明 _MainTex ("Tex", 2D) = "white" {}，
        // 再取消下面两行注释即可（_MainTex 由引擎自动声明为 uniform sampler2D）
        // c *= texture2D(_MainTex, vUv);
        vec4 frag()
        {
            vec4 c = _Color;
            // 菲涅尔边缘光（视线越掠过表面越亮）+ 呼吸脉冲（_Time 驱动）
            float fres = pow(1.0 - max(dot(normalize(vNormalW), normalize(vViewDirW)), 0.0), 3.0);
            float pulse = 0.75 + 0.25 * sin(_Time * _Speed * 6.2831853);
            return vec4(c.rgb * pulse + _RimColor.rgb * _RimColor.a * fres, c.a);
        }
        ENDCG
    }
    FallBack "Diffuse"
}
"##;

/// 新建自定义着色器资产的源码（Shader 指令名 = rel 去扩展名，与资产位置一致）
pub fn serialize_custom_shader_file(rel: &str) -> String {
    CUSTOM_SHADER_TEMPLATE.replace("{NAME}", &crate::scene::migrate::shader_directive_name(rel))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 模板必须可解析、属性齐全、组装结果带入口包装（新建即能渲染）
    #[test]
    fn template_parses_as_custom_program() {
        let text = serialize_custom_shader_file("assets/shaders/My Effect.shader");
        assert!(text.contains("Shader \"assets/shaders/My Effect\""));
        assert!(is_custom_shader(&text));
        let parsed = parse_custom_shader(&text, "assets/shaders/My Effect.shader");
        assert!(parsed.error.is_none(), "{:?}", parsed.error);
        assert_eq!(parsed.properties.len(), 3);
        let color = &parsed.properties[0];
        assert_eq!(color.key, "_Color");
        assert_eq!(color.label, "Base Color");
        assert_eq!(color.kind, PROP_COLOR);
        assert_eq!(color.default, json!(0xffffff));
        let speed = &parsed.properties[2];
        assert_eq!(speed.kind, PROP_RANGE);
        assert_eq!(speed.min, Some(0.0));
        assert_eq!(speed.max, Some(4.0));
        assert_eq!(speed.default, json!(1.0));

        let prog = parsed.program.unwrap();
        // 阶段专属声明：_Color/_Speed/_RimColor/_Time 都只在片元块被引用
        assert!(prog.fragment.contains("uniform vec4 _Color;"));
        assert!(prog.fragment.contains("uniform float _Speed;"));
        assert!(prog.fragment.contains("uniform vec4 _RimColor;"));
        assert!(prog.fragment.contains("uniform float _Time;"));
        assert!(!prog.vertex.contains("uniform "), "顶点阶段无属性引用，不应声明 uniform");
        // 入口包装（vec4 frag() → gl_FragColor 赋值）
        assert!(prog.vertex.contains("void main() { vert(); }"));
        assert!(prog.fragment.contains("gl_FragColor = frag();"));
        // 输出阶段（色调映射 + 输出色彩空间）随包装注入，与内置材质观感一致
        assert!(prog.fragment.contains("#include <tonemapping_fragment>"));
        assert!(prog.fragment.contains("#include <colorspace_fragment>"));
        // 渲染状态默认值
        assert!(!prog.transparent);
        assert!(prog.depth_write);
        assert_eq!(prog.side, "front");
    }

    /// 渲染状态标签（半透明/关深度/双面）与 void 片元入口
    #[test]
    fn render_state_tags_are_parsed() {
        let text = r##"
Shader "assets/shaders/Glow"
{
    Properties { _Glow ("Glow", Range(0, 5)) = 2 }
    SubShader
    {
        Tags { "RenderType"="Transparent" "Queue"="Transparent" "ZWrite"="Off" "Cull"="Off" }
        CGINCLUDE
        varying vec2 vUv;
        ENDCG
        CGPROGRAM
        #pragma vertex vert
        void vert() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
        ENDCG
        CGPROGRAM
        #pragma fragment frag
        void frag() { gl_FragColor = vec4(vUv, _Glow, 1.0); }
        ENDCG
    }
}
"##;
        assert!(is_custom_shader(text));
        let parsed = parse_custom_shader(text, "assets/shaders/Glow.shader");
        let prog = parsed.program.expect("程序应可组装");
        assert!(prog.transparent);
        assert!(!prog.depth_write);
        assert_eq!(prog.side, "double");
        // void 片元入口 → 直接调用
        assert!(prog.fragment.contains("frag();"));
        assert!(prog.fragment.contains("#include <colorspace_fragment>"));
        // 单行 Properties 块也能解析
        assert_eq!(parsed.properties.len(), 1);
        assert_eq!(parsed.properties[0].kind, PROP_RANGE);
    }

    /// Pass 指令写法（ZWrite Off / Cull Front）与无 pragma 时的块顺序识别
    #[test]
    fn pass_style_state_lines_are_accepted() {
        let text = r##"
Shader "assets/shaders/X"
{
    SubShader
    {
        ZWrite Off
        Cull Front
        CGINCLUDE
        ENDCG
        CGPROGRAM
        void vert() { gl_Position = vec4(position, 1.0); }
        ENDCG
        CGPROGRAM
        vec4 frag() { return vec4(1.0); }
        ENDCG
    }
}
"##;
        let parsed = parse_custom_shader(text, "assets/shaders/X.shader");
        let prog = parsed.program.expect("程序应可组装");
        assert!(!prog.depth_write);
        assert_eq!(prog.side, "back");
        assert!(prog.fragment.contains("gl_FragColor = frag();"));
    }

    /// 手工 uniform 声明优先（引擎不重复声明）；属性在顶点块使用时于顶点阶段声明
    #[test]
    fn manual_uniform_declaration_is_respected() {
        let text = r##"
Shader "assets/shaders/Y"
{
    Properties
    {
        _Tint ("Tint", Color) = (1, 1, 1, 1)
        _Scale ("Scale", Float) = 2
    }
    SubShader
    {
        CGINCLUDE
        ENDCG
        CGPROGRAM
        void vert() { gl_Position = vec4(position * _Scale, 1.0); }
        ENDCG
        CGPROGRAM
        uniform vec4 _Tint;
        vec4 frag() { return _Tint; }
        ENDCG
    }
}
"##;
        let parsed = parse_custom_shader(text, "assets/shaders/Y.shader");
        let prog = parsed.program.expect("程序应可组装");
        // 手工声明优先：片元阶段只有一处声明
        assert_eq!(prog.fragment.matches("uniform vec4 _Tint;").count(), 1);
        // _Scale 在顶点块被引用 → 顶点阶段自动声明
        assert!(prog.vertex.contains("uniform float _Scale;"));
        // float 属性的宽松面板范围
        assert_eq!(parsed.properties[1].min, Some(FREE_MIN));
        assert_eq!(parsed.properties[1].max, Some(FREE_MAX));
    }

    /// 仅一个 CGPROGRAM 块 → 报错（顶点/片元必须各一块）
    #[test]
    fn single_block_reports_error() {
        let text = r##"
Shader "assets/shaders/Bad"
{
    SubShader
    {
        CGINCLUDE
        ENDCG
        CGPROGRAM
        void vert() { gl_Position = vec4(position, 1.0); }
        ENDCG
    }
}
"##;
        let parsed = parse_custom_shader(text, "assets/shaders/Bad.shader");
        assert!(parsed.program.is_none());
        assert!(parsed.error.unwrap().contains("缺少顶点/片元"));
    }

    /// 内置分支模板（单块顶点片元 / surface）与注释中的 CGPROGRAM 不判为自定义
    #[test]
    fn custom_detection_ignores_builtin_branches() {
        let unlit = concat!(
            "Shader \"x\"\n{\n SubShader\n {\n CGPROGRAM\n",
            "#pragma vertex vert\n#pragma fragment frag\n",
            "v2f vert (appdata v) {}\n ENDCG\n }\n}\n"
        );
        assert!(!is_custom_shader(unlit));
        let pbr =
            "Shader \"x\"\n{\n SubShader\n {\n CGPROGRAM\n #pragma surface surf Standard\n ENDCG\n }\n}\n";
        assert!(!is_custom_shader(pbr));
        let commented = "Shader \"x\"\n{\n // CGPROGRAM\n CGPROGRAM\n #pragma fragment frag\n fixed4 frag (v2f i) : SV_Target { return 0; }\n ENDCG\n}\n";
        assert!(!is_custom_shader(commented));
    }
}
