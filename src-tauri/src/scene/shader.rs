// ---------------------------------------------------------------------------
// .shader 效果着色器资产格式（后端权威）：Properties + Base + CGINCLUDE + Hook。
//
// 引擎的渲染分支只有三个出口——PBR / Unlit（无光照）/ 卡通；一份着色器资产在其中
// 选择一个（`Base` 声明），并用 Hook 块在该分支的着色阶段叠加自定义效果：
//   Properties → 材质面板暴露的参数（键 = uniform 名；值存材质 .mat 的 props）
//   Base       → 渲染分支（PBR / Unlit / Toon；大小写不敏感，physical 为 PBR 别名）
//   CGINCLUDE  → 共享工具函数（inline 到每个钩子之前）
//   Hook "X"   → 效果片段，注入 three 内置材质的对应着色阶段
//
// 钩子点（name → 注入位置；各分支支持的钩子见 hook_support）：
//   Vertex   → #include <begin_vertex> 后（可修改 transformed = position）
//   Normal   → #include <normal_fragment_maps> 后（可修改 normal）
//   Diffuse  → #include <color_fragment> 后（可修改 diffuseColor）
//   Emissive → #include <emissivemap_fragment> 后（可修改 totalEmissiveRadiance）
//   Fragment → #include <dithering_fragment> 前（可修改 gl_FragColor）
//
// 天空程序（internal/shaders/Sky*.shader）是另一类内置资产：由天空材质引用，
// 用 Tags `"PreviewType"="Skybox"` 标记识别（引擎不做编译，只按标签/采样器映射到
// 内置天空实现），无用户编写入口——本模块一并负责识别与序列化。
//
// 与 public/engine/runtime/shader.mjs（导出产物内的网页运行时）保持同规则，
// 两边需同步修改。
// ---------------------------------------------------------------------------

use serde::Serialize;
use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// Properties 解析（属性表 → 材质面板字段 + uniform 声明）
// ---------------------------------------------------------------------------

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

/// Float/Int 属性的面板取值范围（Range 属性用自身声明的上下界）
const FREE_MIN: f64 = -10000.0;
const FREE_MAX: f64 = 10000.0;

/// 着色器属性（Properties 块的一项）→ 材质面板字段 + uniform 声明
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

/// 去掉行注释（// …）后的内容（仅用于指令/标签/钩子匹配；代码块保留原文）
pub(crate) fn strip_comment(line: &str) -> &str {
    match line.find("//") {
        Some(i) => &line[..i],
        None => line,
    }
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

/// 取 Properties 块文本（`Properties` 后花括号配平的内容；块可与关键字同行或换行），
/// 并解析为属性表。只取第一个 Properties 块；同名属性只保留首个。
pub(crate) fn extract_properties(text: &str) -> Vec<ShaderPropertyDef> {
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

// ---------------------------------------------------------------------------
// 渲染分支（Base）与钩子
// ---------------------------------------------------------------------------

/// 钩子名常量
pub const HOOK_VERTEX: &str = "Vertex";
pub const HOOK_NORMAL: &str = "Normal";
pub const HOOK_DIFFUSE: &str = "Diffuse";
pub const HOOK_EMISSIVE: &str = "Emissive";
pub const HOOK_FRAGMENT: &str = "Fragment";

/// 全部合法钩子名（校验用；各分支支持的集合见 hook_support）
const ALL_HOOKS: [&str; 5] = [HOOK_VERTEX, HOOK_NORMAL, HOOK_DIFFUSE, HOOK_EMISSIVE, HOOK_FRAGMENT];

/// 渲染分支：PBR（physical）
pub const BASE_PBR: &str = "PBR";
/// 渲染分支：Unlit（无光照）
pub const BASE_UNLIT: &str = "Unlit";
/// 渲染分支：卡通
pub const BASE_TOON: &str = "Toon";

/// Base 声明 → 渲染分支 key（physical/unlit/toon）；未知/缺失返回 None
pub fn base_kind(base: &str) -> Option<&'static str> {
    match base.trim().to_ascii_lowercase().as_str() {
        "pbr" | "physical" | "standard" => Some("physical"),
        "unlit" | "basic" => Some("unlit"),
        "toon" => Some("toon"),
        _ => None,
    }
}

/// 渲染分支 key → Base 声明值（新建模板/提示用；同时接受 Base 写法与 kind 写法）
pub fn kind_base(kind: &str) -> &'static str {
    match base_kind(kind) {
        Some("unlit") => BASE_UNLIT,
        Some("toon") => BASE_TOON,
        _ => BASE_PBR,
    }
}

/// 分支支持的钩子（three 内置着色器的注入点差异）：
/// - PBR / 卡通：五个钩子都有对应 chunk，片元阶段也有 vViewPosition；
/// - Unlit（MeshBasicMaterial）：没有法线/自发光阶段 → 只有 Vertex / Diffuse / Fragment。
pub fn hook_support(base: &str) -> &'static [&'static str] {
    match base_kind(base) {
        Some("unlit") => &[HOOK_VERTEX, HOOK_DIFFUSE, HOOK_FRAGMENT],
        _ => &ALL_HOOKS,
    }
}

/// 该（分支, 钩子）下**不可用**的约定变量：Unlit 片元阶段没有 vViewPosition，
/// 也没有法线 → viewDir / normal 都会编译失败，解析阶段就报出来。
fn forbidden_vars(base: &str, hook: &str) -> &'static [&'static str] {
    if base_kind(base) == Some("unlit") && hook != HOOK_VERTEX {
        &["viewDir", "normal"]
    } else {
        &[]
    }
}

/// 按空白与常见标点切词（标识符词法）
fn words(s: &str) -> Vec<&str> {
    s.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty())
        .collect()
}

/// 标识符是否在代码中以独立单词出现
fn mentions(text: &str, key: &str) -> bool {
    words(text).iter().any(|w| *w == key)
}

/// 扩展着色器钩子（一个效果片段）
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShaderHook {
    /// 钩子名（Vertex/Normal/Diffuse/Emissive/Fragment）
    pub name: String,
    /// 钩子体 GLSL 代码（注入到内置着色器对应阶段）
    pub code: String,
}

/// 着色器解析结果（属性表 + Base + CGINCLUDE + 钩子 + 错误）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShaderParse {
    /// 属性表（uniform 声明 + 材质面板字段）
    pub properties: Vec<ShaderPropertyDef>,
    /// 渲染分支声明（PBR/Unlit/Toon；未声明为空串）
    pub base: String,
    /// CGINCLUDE 共享代码（工具函数，inline 到各钩子）
    pub include: String,
    /// 钩子列表（按声明顺序）
    pub hooks: Vec<ShaderHook>,
    /// 解析错误（null = 无错误；非 null 时材质仍按 Base 分支渲染，只是不叠加效果）
    pub error: Option<String>,
}

/// 从引号中取文本：`Base "PBR"` → "PBR"
fn quoted_value(line: &str, keyword: &str) -> Option<String> {
    let t = line.trim();
    let rest = t.strip_prefix(keyword)?.trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// 提取 Base 声明（`Base "PBR"` 行 → "PBR"；未声明返回空串）
fn extract_base(text: &str) -> String {
    for line in text.lines() {
        let t = strip_comment(line).trim();
        if let Some(v) = quoted_value(t, "Base") {
            return v;
        }
    }
    String::new()
}

/// 旧版着色器（重构前：按 pragma 判别的渲染分支程序，无 Base 声明）→ 建议补的 Base。
/// 只用于「缺 Base」时的迁移提示与建议值，不参与正常解析：
///   `#pragma surface surf Toon` → Toon；其余 surface → PBR；
///   仅顶点片元 pragma（无 surface）→ Unlit；无法判别 → PBR。
pub fn legacy_base(text: &str) -> &'static str {
    for line in text.lines() {
        let t = strip_comment(line).trim();
        let Some(rest) = t.strip_prefix("#pragma") else { continue };
        let rest = rest.trim_start();
        if let Some(rest) = rest.strip_prefix("surface") {
            let mut it = rest.split_whitespace();
            let _func = it.next();
            return if it.next().unwrap_or("").eq_ignore_ascii_case("toon") {
                BASE_TOON
            } else {
                BASE_PBR
            };
        }
        if rest.starts_with("fragment") || rest.starts_with("vertex") {
            return BASE_UNLIT;
        }
    }
    BASE_PBR
}

/// 提取 CGINCLUDE 块内容（ENDCG 结束）
fn extract_include(text: &str) -> String {
    let mut include = String::new();
    let mut in_include = false;
    for line in text.lines() {
        let t = strip_comment(line).trim();
        if in_include {
            if t == "ENDCG" {
                in_include = false;
                continue;
            }
            include.push_str(line);
            include.push('\n');
            continue;
        }
        if t == "CGINCLUDE" {
            in_include = true;
        }
    }
    include
}

/// 提取所有 Hook 块（`Hook "Name" { ... }`）；未知钩子名/分支不支持的钩子/不可用
/// 变量都返回错误（首个错误即返回，附上可操作的原因）
fn extract_hooks(base: &str, text: &str) -> (Vec<ShaderHook>, Option<String>) {
    let mut hooks: Vec<ShaderHook> = Vec::new();
    let mut lines = text.lines().peekable();

    while let Some(line) = lines.next() {
        let t = strip_comment(line).trim();
        let Some(rest) = t.strip_prefix("Hook") else {
            continue;
        };
        let rest = rest.trim_start();
        // 取引号内的钩子名
        let Some(name) = rest.strip_prefix('"').and_then(|r| r.find('"').map(|end| r[..end].to_string())) else {
            continue;
        };
        // 校验钩子名
        if !ALL_HOOKS.iter().any(|h| h.eq_ignore_ascii_case(&name)) {
            return (
                hooks,
                Some(format!(
                    "未知钩子名 \"{name}\"：合法钩子为 {}",
                    ALL_HOOKS.join(" / ")
                )),
            );
        }
        let normalized = ALL_HOOKS
            .iter()
            .find(|h| h.eq_ignore_ascii_case(&name))
            .unwrap()
            .to_string();
        // 校验分支是否支持该钩子
        if !hook_support(base).iter().any(|h| *h == normalized) {
            return (
                hooks,
                Some(format!(
                    "钩子 \"{normalized}\" 不适用于 {} 分支：可用钩子为 {}",
                    kind_base(base),
                    hook_support(base).join(" / ")
                )),
            );
        }
        // 找花括号块体（同行开始或后续行开始）
        let after_name = &rest[name.len() + 2..]; // 跳过 "name"
        let mut depth = 0i32;
        let mut code = String::new();
        let mut started = false;

        for seg in std::iter::once(after_name).chain(lines.by_ref()) {
            for ch in strip_comment(seg).chars() {
                match ch {
                    '{' => {
                        depth += 1;
                        started = true;
                    }
                    '}' => depth -= 1,
                    _ => {
                        if started && depth > 0 {
                            code.push(ch);
                        }
                    }
                }
            }
            if started && depth > 0 {
                code.push('\n');
            }
            if started && depth <= 0 {
                break;
            }
        }

        let code = code.trim().to_string();
        let forbidden: Vec<&str> = forbidden_vars(base, &normalized)
            .iter()
            .copied()
            .filter(|v| mentions(&code, v))
            .collect();
        if !forbidden.is_empty() {
            return (
                hooks,
                Some(format!(
                    "钩子 \"{normalized}\" 在 {} 分支下不能用 {}（Unlit 没有法线，片元阶段不存在 vViewPosition）",
                    kind_base(base),
                    forbidden.join(" / ")
                )),
            );
        }
        if !hooks.iter().any(|h| h.name == normalized) {
            hooks.push(ShaderHook {
                name: normalized,
                code,
            });
        }
    }
    (hooks, None)
}

/// 解析着色器源码 → 属性表 + Base + CGINCLUDE + 钩子列表（+ 首个错误）
pub fn parse_shader(text: &str) -> ShaderParse {
    // 天空程序：另一类内置资产（天空材质引用），属性/钩子不参与效果着色器管线
    if is_sky_program(text) {
        return ShaderParse {
            properties: Vec::new(),
            base: String::new(),
            include: String::new(),
            hooks: Vec::new(),
            error: None,
        };
    }
    let properties = extract_properties(text);
    let base = extract_base(text);
    let include = extract_include(text);
    let (hooks, hook_err) = extract_hooks(&base, text);

    let error = hook_err.or_else(|| {
        if base.trim().is_empty() {
            // 区分「旧版着色器迁移」与「手写漏写」：前者给出按 pragma 推断的建议 Base
            let legacy = text.contains("#pragma");
            let suggested = legacy_base(text);
            Some(if legacy {
                format!(
                    "未声明 Base：本文件是旧版着色器（按旧规则识别为 {suggested} 分支），请补一行 Base \"{suggested}\"（该行决定材质走哪个渲染分支；补上后即可用 Hook 叠加效果）"
                )
            } else {
                format!(
                    "未声明 Base：请在文件里补一行 Base \"{}\"（或 \"{}\" / \"{}\"），决定材质走哪个渲染分支",
                    BASE_PBR, BASE_UNLIT, BASE_TOON
                )
            })
        } else if base_kind(&base).is_none() {
            Some(format!(
                "未知 Base \"{base}\"：可用 {} / {} / {}",
                BASE_PBR, BASE_UNLIT, BASE_TOON
            ))
        } else {
            None
        }
    });

    ShaderParse {
        properties,
        base,
        include,
        hooks,
        error,
    }
}

/// 是否为天空程序（天空盒惯例 PreviewType=Skybox 标签）
pub fn is_sky_program(text: &str) -> bool {
    text.contains(r#""PreviewType"="Skybox""#)
}

/// 着色器源码 → 渲染分支 key（physical/unlit/toon/skyprocedural/skycube）。
/// 天空程序按标签+采样器判别；其余按 Base 声明判别；无法判别返回 None。
pub fn shader_kind(text: &str) -> Option<String> {
    if is_sky_program(text) {
        return Some(
            if text.contains("samplerCUBE") {
                "skycube"
            } else {
                "skyprocedural"
            }
            .to_string(),
        );
    }
    base_kind(&extract_base(text)).map(str::to_string)
}

/// 着色器源码 → Shader 指令名（去组前缀）；无指令行返回 None
pub fn shader_name(text: &str) -> Option<String> {
    for line in text.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("Shader ").or_else(|| t.strip_prefix("shader ")) {
            let rest = rest.trim_start();
            if let Some(quoted) = rest.strip_prefix('"') {
                if let Some(end) = quoted.find('"') {
                    let full = &quoted[..end];
                    let bare = full.rsplit('/').next().unwrap_or(full);
                    return Some(bare.trim().to_string());
                }
            }
        }
    }
    None
}

/// 是否为可解析的着色器文档（含 `Shader "名称"` 指令）
pub fn is_shader_doc(text: &str) -> bool {
    shader_name(text).is_some()
}

// ---------------------------------------------------------------------------
// 新建模板与序列化（Shader 指令名 = 资产 rel 去扩展名）
// ---------------------------------------------------------------------------

/// 效果着色器模板头部说明（三个分支模板共用；{BASE} 由分支名替换）
const EFFECT_TEMPLATE_HEADER: &str = r##"// TVE 着色器（ShaderLab 风格；.shader = 效果着色器资产）
// 引擎的渲染分支只有三个出口：PBR / Unlit（无光照）/ 卡通；Base 决定本资产用哪个。
// - Properties：每一项自动成为材质面板的可调参数（值存材质 .mat 的 props 字段）
// - CGINCLUDE：共享工具函数（inline 到每个钩子之前）
// - Hook "…"：效果片段，注入到内置着色器的对应阶段（见下方可用钩子）
// 钩子内可用变量：normal（世界法线）/ viewDir（视线方向）/ uv / _Time（运行秒数）；
//   可修改变量按钩子而定（position / normal / diffuseColor / emissive / fragColor）
// 改完在资产检查器「编辑源码」里保存（Ctrl+S）即生效；详细说明见
// public/docs/editor/shaders.md。"##;

/// PBR（原理化 BSDF）分支的效果着色器模板
const PBR_SHADER_TEMPLATE: &str = r##"Shader "{NAME}"
{
    Properties
    {
        // 自定义效果的参数写在这里（面板可调；不需要就留空）：
        // _RimColor ("Rim Color", Color) = (0.35, 0.65, 1, 1)
        // _RimPower ("Rim Power", Range(0.5, 8)) = 3
    }
    Base "PBR"

    // 可用钩子：Vertex / Normal / Diffuse / Emissive / Fragment（按需取消注释并改写）
    // Hook "Emissive"
    // {
    //     float rim = pow(1.0 - max(dot(normal, viewDir), 0.0), _RimPower);
    //     emissive += rim * _RimColor.rgb;
    // }
}
"##;

/// Unlit（无光照）分支的效果着色器模板
const UNLIT_SHADER_TEMPLATE: &str = r##"Shader "{NAME}"
{
    Properties
    {
        // 自定义效果的参数写在这里（面板可调；不需要就留空）：
        // _Tint ("Tint", Color) = (1, 1, 1, 1)
    }
    Base "Unlit"

    // 可用钩子：Vertex / Diffuse / Fragment（Unlit 没有法线/自发光阶段，
    // 故不支持 Normal / Emissive，且片元阶段不存在 viewDir / normal 变量）
    // Hook "Diffuse"
    // {
    //     diffuseColor.rgb *= _Tint.rgb;
    // }
}
"##;

/// 卡通（cel shading）分支的效果着色器模板
const TOON_SHADER_TEMPLATE: &str = r##"Shader "{NAME}"
{
    Properties
    {
        // 自定义效果的参数写在这里（面板可调；不需要就留空）：
        // _OutlinePulse ("Pulse", Range(0, 1)) = 0.2
    }
    Base "Toon"

    // 可用钩子：Vertex / Normal / Diffuse / Emissive / Fragment（按需取消注释并改写）
    // Hook "Emissive"
    // {
    //     emissive += vec3(0.1) * (0.5 + 0.5 * sin(_Time));
    // }
}
"##;

// 天空程序（天空盒惯例）：Tags 携带 "PreviewType"="Skybox" 标记，引擎据此与材质
// .mat 的 kind 字段映射渲染（skyprocedural→大气散射 / skycube→立方体贴图）。

const SKY_PROCEDURAL_SHADER_TEMPLATE: &str = r##"// TVE 天空程序（内置资产；由天空材质引用，无效果着色器入口）
// 天空程序：PreviewType=Skybox 标签 + _SUNDISK 关键字标记程序化大气散射
// （TVE 引擎内为透射 LUT + 多重散射双 pass 的等价实现）。
Shader "{NAME}"
{
    Properties
    {
        _SunSize ("Sun Size", Range(0.1, 30)) = 1
        _SunStrength ("Sun Strength", Range(0, 20)) = 1
        _SunElevation ("Sun Elevation", Range(-90, 90)) = 25
        _SunRotation ("Sun Rotation", Range(0, 360)) = 0
        _Altitude ("Altitude", Range(0, 20000)) = 0
        _Air ("Air Density", Range(0, 10)) = 1
        _Dust ("Dust Density", Range(0, 10)) = 1
        _Ozone ("Ozone Density", Range(0, 10)) = 1
        [Toggle] _ms ("Multiple Scattering", Float) = 1
    }
    SubShader
    {
        Tags { "Queue"="Background" "RenderType"="Background" "PreviewType"="Skybox" }
        Cull Off ZWrite Off

        CGPROGRAM
        // Nishita 大气散射：太阳方向由高度角/方位角给出，
        // 散射沿视线解析积分；_SUNDISK 关键字同时作为 TVE 的种类识别标记
        #pragma vertex vert
        #pragma fragment frag
        #pragma multi_compile _ _SUNDISK_NONE _SUNDISK_SIMPLE _SUNDISK_HIGH_QUALITY
        #pragma target 3.0

        #include "UnityCG.cginc"

        half _SunSize;
        half _SunStrength;
        half _SunElevation;
        half _SunRotation;
        half _Altitude;
        half _Air;
        half _Dust;
        half _Ozone;
        half _ms;

        struct appdata
        {
            float4 vertex : POSITION;
        };

        struct v2f
        {
            float4 pos : SV_POSITION;
            float3 dir : TEXCOORD0;
        };

        v2f vert (appdata v)
        {
            v2f o;
            o.pos = UnityObjectToClipPos(v.vertex);
            float3 w = mul((float3x3)unity_ObjectToWorld, v.vertex.xyz);
            o.dir = normalize(w - _WorldSpaceCameraPos);
            return o;
        }

        // 太阳方向：高度角 + 方位角（度）
        float3 SunDirection ()
        {
            half el = radians(_SunElevation);
            half az = radians(_SunRotation);
            return normalize(float3(cos(el) * sin(az), sin(el), cos(el) * cos(az)));
        }

        fixed4 frag (v2f i) : SV_Target
        {
            float3 dir = normalize(i.dir);
            float3 sun = SunDirection();
            half cosSun = dot(dir, sun);
            // 瑞利 + 米氏相位近似：空气/气溶胶密度缩放，地平线方向增厚，臭氧吸收
            half horizon = 1 - abs(dir.y);
            float3 rayleigh = float3(0.18, 0.42, 0.92) * (0.055 + 0.35 * horizon * horizon) * _Air;
            float3 mie = float3(1.0, 0.86, 0.68) * (0.018 + 0.12 * pow(saturate(cosSun * 0.5 + 0.5), 8)) * _Dust;
            float3 col = rayleigh + mie;
            #if defined(_SUNDISK_SIMPLE) || defined(_SUNDISK_HIGH_QUALITY)
            // 日轮：平台高斯软边缘（小尺寸亮核不缩水、无硬边锯齿）
            half d = distance(dir, sun);
            half disc = exp(-6.0 * pow(saturate(d / max(_SunSize * 0.01, 0.001) - 0.5), 2.0));
            col += _SunStrength * disc * float3(1.0, 0.95, 0.85);
            #endif
            return fixed4(col, 1);
        }
        ENDCG
    }
    FallBack Off
}
"##;

const SKY_CUBE_SHADER_TEMPLATE: &str = r##"// TVE 天空程序（内置资产；由天空材质引用，无效果着色器入口）
// 天空程序：PreviewType=Skybox 标签 + samplerCUBE 采样标记立方体贴图天空盒
// （贴图引用与渲染参数存于材质 .mat 的 cubeMap/rotation/strength/blur 字段）。
Shader "{NAME}"
{
    Properties
    {
        _CubeMap ("Cubemap (HDR)", CUBE) = "" {}
        _Rotation ("Rotation", Range(0, 360)) = 0
        _Strength ("Strength", Range(0, 16)) = 1
        _Blur ("Blur", Range(0, 1)) = 0
    }
    SubShader
    {
        Tags { "Queue"="Background" "RenderType"="Background" "PreviewType"="Skybox" }
        Cull Off ZWrite Off

        CGPROGRAM
        // 立方体贴图天空：视线方向绕世界 Y 轴旋转后采样 CUBE（mip 级别近似模糊）
        #pragma vertex vert
        #pragma fragment frag
        #pragma target 3.0

        #include "UnityCG.cginc"

        samplerCUBE _CubeMap;
        half _Rotation;
        half _Strength;
        half _Blur;

        struct appdata
        {
            float4 vertex : POSITION;
        };

        struct v2f
        {
            float4 pos : SV_POSITION;
            float3 dir : TEXCOORD0;
        };

        v2f vert (appdata v)
        {
            v2f o;
            o.pos = UnityObjectToClipPos(v.vertex);
            float3 w = mul((float3x3)unity_ObjectToWorld, v.vertex.xyz);
            o.dir = normalize(w - _WorldSpaceCameraPos);
            return o;
        }

        fixed4 frag (v2f i) : SV_Target
        {
            float3 dir = normalize(i.dir);
            half rad = radians(_Rotation);
            float3 rotated = float3(
                cos(rad) * dir.x + sin(rad) * dir.z,
                dir.y,
                -sin(rad) * dir.x + cos(rad) * dir.z);
            half mip = _Blur * 8.0;
            return fixed4(texCUBElod(_CubeMap, float4(rotated, mip)).rgb * _Strength, 1);
        }
        ENDCG
    }
    FallBack Off
}
"##;

/// .shader 指令名 = 资产相对路径去扩展名（如 "internal/shaders/PBR.shader" →
/// "internal/shaders/PBR"），保证 Shader "…" 与资产路径始终一致
pub(crate) fn shader_directive_name(rel: &str) -> String {
    let rel = rel.trim().replace('\\', "/");
    let stem = rel.strip_suffix(".shader").unwrap_or(&rel);
    stem.to_string()
}

/// 着色器文档 → .shader 源码（ShaderLab 风格；kind 决定模板）。
/// rel 为着色器资产相对路径：Shader 指令名 = 路径去扩展名，保证与资产位置一致。
/// 效果着色器（PBR/Unlit/卡通）前置统一的用法说明头；天空程序自带说明头。
pub fn serialize_shader_file(rel: &str, kind: &str) -> String {
    let (header, template) = match kind.trim() {
        "unlit" => (EFFECT_TEMPLATE_HEADER, UNLIT_SHADER_TEMPLATE),
        "toon" => (EFFECT_TEMPLATE_HEADER, TOON_SHADER_TEMPLATE),
        "skyprocedural" => ("", SKY_PROCEDURAL_SHADER_TEMPLATE),
        "skycube" => ("", SKY_CUBE_SHADER_TEMPLATE),
        _ => (EFFECT_TEMPLATE_HEADER, PBR_SHADER_TEMPLATE),
    };
    let body = template.replace("{NAME}", &shader_directive_name(rel));
    if header.is_empty() {
        body
    } else {
        format!("{header}\n{body}")
    }
}

/// 把着色器源码里的 `Shader "…"` 指令改写为与资产 rel 一致（纯文本变换）：
/// 无 Shader 指令行返回 None；指令已一致返回 None（无需改写）；否则返回新文本。
/// 供复制/移动后的跟随改写与「保存着色器源码」共用。
pub(crate) fn sync_shader_directive_text(text: &str, rel: &str) -> Option<String> {
    let directive = format!("Shader \"{}\"", shader_directive_name(rel));
    let mut out: Vec<String> = Vec::new();
    let mut replaced = false;
    for line in text.lines() {
        let t = line.trim();
        if !replaced && (t.starts_with("Shader ") || t.starts_with("shader ")) {
            out.push(directive.clone());
            replaced = true;
        } else {
            out.push(line.to_string());
        }
    }
    if !replaced {
        return None;
    }
    let mut new_text = out.join("\n");
    new_text.push('\n');
    if new_text == text.replace("\r\n", "\n") {
        return None;
    }
    Some(new_text)
}

/// 把资产（.shader 文件，或目录下全部 .shader）的 Shader 指令改写为与当前
/// 路径一致——复制/导入/移动/重命名后调用，指令随位置跟随。
/// 非着色器文档跳过；改写失败不报错（跟随改写是尽力而为的元数据修正）。
pub(crate) fn rewrite_shader_directive(root: &std::path::Path, rel: &str) {
    let Ok(root_abs) = root.canonicalize() else {
        return;
    };
    let Ok(target) = crate::project::resolve_in_root(&root_abs, rel) else {
        return;
    };
    if target.is_dir() {
        let Ok(rd) = std::fs::read_dir(&target) else {
            return;
        };
        for entry in rd.flatten() {
            let child = entry.path();
            let name = child.file_name().map(|s| s.to_string_lossy().to_string());
            let Some(name) = name else { continue };
            let child_rel = format!("{}/{}", rel.trim_end_matches('/'), name);
            if child.is_dir() {
                rewrite_shader_directive(root, &child_rel);
            } else if name.to_ascii_lowercase().ends_with(".shader") {
                rewrite_shader_directive(root, &child_rel);
            }
        }
        return;
    }
    if !rel.to_ascii_lowercase().ends_with(".shader") {
        return;
    }
    let Ok(text) = std::fs::read_to_string(&target) else {
        return;
    };
    // 仅改写可解析的着色器（外部任意 ShaderLab 也支持；无 Shader 指令行则不动）
    if !is_shader_doc(&text) {
        return;
    }
    if let Some(new_text) = sync_shader_directive_text(&text, rel) {
        let _ = std::fs::write(&target, new_text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 属性类型/上下界/默认值全类型解析
    #[test]
    fn parses_every_property_kind() {
        let text = r##"
Shader "assets/shaders/Effect"
{
    Properties
    {
        _Tint ("Tint", Color) = (1, 0.5, 0, 1)
        _Amount ("Amount", Range(0, 1)) = 0.25
        _Scale ("Scale", Float) = 2
        _Steps ("Steps", Int) = 4
        _Dir ("Dir", Vector) = (0, 1, 0, 0)
        _MainTex ("Tex", 2D) = "white" {}
    }
    Base "PBR"
    Hook "Emissive" { emissive += _Tint.rgb * _Amount; }
}
"##;
        let parsed = parse_shader(text);
        assert!(parsed.error.is_none(), "{:?}", parsed.error);
        assert_eq!(parsed.base, "PBR");
        assert_eq!(parsed.properties.len(), 6);
        assert_eq!(parsed.properties[0].key, "_Tint");
        assert_eq!(parsed.properties[0].label, "Tint");
        assert_eq!(parsed.properties[0].kind, PROP_COLOR);
        // 颜色默认值 = RGB（忽略 alpha）
        assert_eq!(parsed.properties[0].default, json!(0xff8000));
        assert_eq!(parsed.properties[1].kind, PROP_RANGE);
        assert_eq!(parsed.properties[1].min, Some(0.0));
        assert_eq!(parsed.properties[1].max, Some(1.0));
        assert_eq!(parsed.properties[2].min, Some(FREE_MIN));
        assert_eq!(parsed.properties[3].kind, PROP_INT);
        assert_eq!(parsed.properties[4].default, json!([0.0, 1.0, 0.0, 0.0]));
        assert_eq!(parsed.properties[5].kind, PROP_TEXTURE);
        assert_eq!(parsed.properties[5].default, json!(""));
    }

    /// 三个内置模板都要可解析、Base 与请求的分支一致（新建即可用）
    #[test]
    fn templates_parse_with_expected_base() {
        for (rel, kind, base) in [
            ("assets/shaders/MyPbr.shader", "physical", "PBR"),
            ("assets/shaders/MyUnlit.shader", "unlit", "Unlit"),
            ("assets/shaders/MyToon.shader", "toon", "Toon"),
        ] {
            let text = serialize_shader_file(rel, kind);
            assert!(
                text.contains(&format!("Shader \"{}\"", shader_directive_name(rel))),
                "{kind} 模板指令名应跟随路径"
            );
            // 注释里出现的属性/钩子不得被解析（模板默认无参数、无钩子）
            let parsed = parse_shader(&text);
            assert!(parsed.error.is_none(), "{kind} 模板解析失败: {:?}", parsed.error);
            assert_eq!(parsed.base, base);
            assert!(parsed.properties.is_empty(), "{kind} 模板不应含实际属性");
            assert!(parsed.hooks.is_empty(), "{kind} 模板不应含实际钩子");
            assert_eq!(shader_kind(&text).as_deref(), Some(kind));
        }
    }

    /// Base 归一（大小写 + physical 别名）与未知 Base 报错
    #[test]
    fn base_is_normalized_and_validated() {
        assert_eq!(base_kind("pbr"), Some("physical"));
        assert_eq!(base_kind("Physical"), Some("physical"));
        assert_eq!(base_kind(" unlit "), Some("unlit"));
        assert_eq!(base_kind("TOON"), Some("toon"));
        assert_eq!(base_kind("Lambert"), None);

        let text = "Shader \"x\"\n{\n    Base \"Lambert\"\n}\n";
        let parsed = parse_shader(text);
        assert!(parsed.error.unwrap().contains("未知 Base \"Lambert\""));

        let no_base = "Shader \"x\"\n{\n    Hook \"Fragment\" { fragColor.rgb *= 0.5; }\n}\n";
        let parsed2 = parse_shader(no_base);
        assert!(parsed2.error.unwrap().contains("未声明 Base"));
    }

    /// 分支 × 钩子支持：Unlit 不支持 Normal/Emissive，也不允许 viewDir/normal
    #[test]
    fn hook_support_is_base_aware() {
        assert_eq!(hook_support("PBR").len(), 5);
        assert_eq!(hook_support("Toon").len(), 5);
        assert_eq!(hook_support("unlit"), &[HOOK_VERTEX, HOOK_DIFFUSE, HOOK_FRAGMENT]);

        let emissive_on_unlit = "Shader \"x\"\n{\n    Base \"Unlit\"\n    Hook \"Emissive\" { emissive += vec3(1.0); }\n}\n";
        let parsed = parse_shader(emissive_on_unlit);
        let err = parsed.error.expect("Unlit 上的 Emissive 应报错");
        assert!(err.contains("不适用于 Unlit 分支"), "{err}");

        let viewdir_on_unlit = "Shader \"x\"\n{\n    Base \"Unlit\"\n    Hook \"Diffuse\" { diffuseColor.rgb *= 0.5 + dot(normal, viewDir); }\n}\n";
        let parsed2 = parse_shader(viewdir_on_unlit);
        let err2 = parsed2.error.expect("Unlit 片元钩子用 viewDir/normal 应报错");
        assert!(err2.contains("viewDir / normal"), "{err2}");

        // 顶点钩子不受限（Unlit 顶点阶段有 normal 属性）
        let vert_on_unlit = "Shader \"x\"\n{\n    Base \"Unlit\"\n    Hook \"Vertex\" { position += normal * 0.1; }\n}\n";
        assert!(parse_shader(vert_on_unlit).error.is_none());
    }

    /// 未知钩子名 / 多钩子 / CGINCLUDE / 无钩子（合法：只选分支不叠效果）
    #[test]
    fn hooks_and_include_are_parsed() {
        let text = r##"
Shader "assets/shaders/Dissolve"
{
    Base "physical"
    CGINCLUDE
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    ENDCG
    Hook "Diffuse"
    {
        float h = hash(uv * 100.0);
        if (h < 0.5) discard;
    }
    Hook "Emissive"
    {
        emissive += vec3(1.0, 0.5, 0.0) * 0.2;
    }
}
"##;
        let parsed = parse_shader(text);
        assert!(parsed.error.is_none(), "{:?}", parsed.error);
        assert_eq!(parsed.base, "physical");
        assert_eq!(parsed.hooks.len(), 2);
        assert_eq!(parsed.hooks[0].name, "Diffuse");
        assert!(parsed.hooks[0].code.contains("discard"));
        assert!(parsed.include.contains("hash"));

        let unknown = "Shader \"x\"\n{\n    Base \"PBR\"\n    Hook \"Nope\" { }\n}\n";
        assert!(parse_shader(unknown).error.unwrap().contains("未知钩子名"));

        let no_hooks = "Shader \"x\"\n{\n    Base \"PBR\"\n}\n";
        let plain = parse_shader(no_hooks);
        assert!(plain.error.is_none(), "无钩子合法（只选分支）");
        assert!(plain.hooks.is_empty());
        assert_eq!(shader_kind(no_hooks).as_deref(), Some("physical"));
    }

    /// 天空程序：按标签识别种类、不参与效果着色器解析（属性/钩子为空）
    #[test]
    fn sky_programs_are_recognized() {
        for (kind, expect) in [("skyprocedural", "skyprocedural"), ("skycube", "skycube")] {
            let text = serialize_shader_file(&format!("internal/shaders/{kind}.shader"), kind);
            assert!(is_sky_program(&text));
            assert_eq!(shader_kind(&text).as_deref(), Some(expect));
            let parsed = parse_shader(&text);
            assert!(parsed.error.is_none());
            assert!(parsed.properties.is_empty() && parsed.hooks.is_empty());
        }
    }

    /// 指令名解析与文档判别（保存校验/指令跟随路径用）
    #[test]
    fn name_and_doc_detection() {
        assert_eq!(
            shader_name("Shader \"Group/My Effect\"\n{\n}\n").as_deref(),
            Some("My Effect")
        );
        assert!(is_shader_doc("// 注释\nShader \"x\"\n{\n}\n"));
        assert!(!is_shader_doc("{\"$type\":\"material\"}"));
        assert!(!is_shader_doc("not a shader"));
    }

    /// 保存着色器源码时的 Shader 指令同步：路径不符改写、已一致不改写
    #[test]
    fn sync_shader_directive_text_rewrites_only_when_needed() {
        let text = "Shader \"Assets/Old Name\"\n{\n}\n";
        let out = sync_shader_directive_text(text, "assets/shaders/New.shader").unwrap();
        assert!(out.starts_with("Shader \"assets/shaders/New\""));
        assert!(sync_shader_directive_text(&out, "assets/shaders/New.shader").is_none());
        assert!(sync_shader_directive_text("// 无指令", "assets/shaders/New.shader").is_none());
    }
}


#[cfg(test)]
mod legacy_tests {
    use super::*;

    /// 旧版着色器（pragma 型，无 Base）：按 pragma 推断出建议 Base，并给出可操作的迁移提示
    #[test]
    fn legacy_shader_suggests_base() {
        let cases = [
            (
                "Shader \"assets/shaders/Old\"\n{\n    SubShader\n    {\n        CGPROGRAM\n        #pragma surface surf Standard\n        ENDCG\n    }\n}\n",
                "PBR",
            ),
            (
                "Shader \"assets/shaders/OldToon\"\n{\n    SubShader\n    {\n        CGPROGRAM\n        #pragma surface surf Toon\n        ENDCG\n    }\n}\n",
                "Toon",
            ),
            (
                "Shader \"assets/shaders/OldUnlit\"\n{\n    SubShader\n    {\n        CGPROGRAM\n        #pragma vertex vert\n        #pragma fragment frag\n        ENDCG\n    }\n}\n",
                "Unlit",
            ),
        ];
        for (src, base) in cases {
            assert_eq!(legacy_base(src), base, "旧版 pragma 推断 Base");
            let parsed = parse_shader(src);
            let err = parsed.error.expect("缺 Base 应报错");
            assert!(err.contains("旧版着色器"), "{err}");
            assert!(err.contains(&format!("Base \"{base}\"")), "{err}");
            assert_eq!(shader_kind(src), None, "旧版文件不解析出渲染分支（调用方回退默认）");
        }
        // 手写文件（无 pragma）：给通用提示，不含「旧版」措辞
        let handwritten = "Shader \"x\"\n{\n    Hook \"Fragment\" { fragColor.rgb *= 0.5; }\n}\n";
        let err = parse_shader(handwritten).error.unwrap();
        assert!(err.contains("请在文件里补一行 Base"), "{err}");
        assert!(!err.contains("旧版"), "{err}");
    }
}
