// ---------------------------------------------------------------------------
// 场景数据逻辑（Rust 权威）：
// - 材质参数读取/收敛/序列化（.mat 文件格式，与前端 material/types.ts、
//   materialFile.ts 同构）；
// - 场景引用收集（材质/模型，供装载预取与网页预览导出）；
// - 旧场景迁移：材质参数内嵌时代（meshNode 上的 color/metalness/… 字段）
//   装载时"另存"为项目 .mat 资产并改写节点为 material 引用。
// ---------------------------------------------------------------------------

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

pub const MATERIAL_EXT: &str = ".mat";
/// 着色器资产文件扩展名
pub(crate) const SHADER_EXT: &str = ".shader";
pub const DEFAULT_MATERIAL_REL: &str = "internal/materials/Default.mat";
const LEGACY_KEYS: [&str; 5] = ["color", "metalness", "roughness", "emissive", "wireframe"];

/// 材质参数（PBR 超集；缺失字段回退默认——与 DEFAULT_MATERIAL_PARAMS 一致）。
/// serde 为前端 IPC 形态（camelCase、颜色为数字、贴图为字符串）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MaterialParams {
    pub color: i64,
    pub metalness: f64,
    pub roughness: f64,
    pub specular_intensity: f64,
    pub specular_color: i64,
    pub ior: f64,
    pub emissive: i64,
    pub emissive_intensity: f64,
    pub emission_enabled: bool,
    pub clearcoat: f64,
    pub clearcoat_roughness: f64,
    pub clearcoat_enabled: bool,
    pub sheen: f64,
    pub sheen_color: i64,
    pub sheen_roughness: f64,
    pub sheen_enabled: bool,
    pub transmission: f64,
    pub thickness: f64,
    pub attenuation_color: i64,
    pub attenuation_distance: f64,
    pub transmission_enabled: bool,
    pub anisotropy: f64,
    pub anisotropy_rotation: f64,
    pub iridescence: f64,
    /// three.js 属性名即资产/IPC 键：serde 的 camelCase 会把 ior 规整成 Ior，
    /// 这里显式钉住前端与 .mat 文件的写法（iridescenceIOR），否则 material_write 参数缺失。
    #[serde(rename = "iridescenceIOR")]
    pub iridescence_ior: f64,
    pub opacity: f64,
    pub alpha_clip_threshold: f64,
    pub wireframe: bool,
    pub toon_steps: i64,
    pub toon_shadow_strength: f64,
    pub outline_enabled: bool,
    pub outline_color: i64,
    pub outline_width: f64,
    pub map: String,
    pub metalness_map: String,
    pub roughness_map: String,
    pub normal_map: String,
    pub emissive_map: String,
}

impl Default for MaterialParams {
    fn default() -> Self {
        Self {
            color: 0x9aa4b2,
            metalness: 0.1,
            roughness: 0.75,
            specular_intensity: 1.0,
            specular_color: 0xffffff,
            ior: 1.5,
            emissive: 0x000000,
            emissive_intensity: 1.0,
            emission_enabled: false,
            clearcoat: 0.0,
            clearcoat_roughness: 0.0,
            clearcoat_enabled: false,
            sheen: 0.0,
            sheen_color: 0xffffff,
            sheen_roughness: 0.5,
            sheen_enabled: false,
            transmission: 0.0,
            thickness: 0.0,
            attenuation_color: 0xffffff,
            attenuation_distance: 0.0,
            transmission_enabled: false,
            anisotropy: 0.0,
            anisotropy_rotation: 0.0,
            iridescence: 0.0,
            iridescence_ior: 1.3,
            opacity: 1.0,
            alpha_clip_threshold: 0.5,
            wireframe: false,
            toon_steps: 3,
            toon_shadow_strength: 0.6,
            outline_enabled: false,
            outline_color: 0x000000,
            outline_width: 0.02,
            map: String::new(),
            metalness_map: String::new(),
            roughness_map: String::new(),
            normal_map: String::new(),
            emissive_map: String::new(),
        }
    }
}

/// 颜色：number / "#rrggbb" → RGB hex（失败回退 fallback）
fn parse_color_hex(v: &Value, fallback: i64) -> i64 {
    match v {
        Value::Number(n) => n.as_f64().map(|f| (f as i64) & 0xffffff).unwrap_or(fallback),
        Value::String(s) => {
            let s = s.trim().trim_start_matches('#');
            if s.len() == 6 && s.chars().all(|c| c.is_ascii_hexdigit()) {
                i64::from_str_radix(s, 16).unwrap_or(fallback) & 0xffffff
            } else if s.len() == 3 && s.chars().all(|c| c.is_ascii_hexdigit()) {
                let n = i64::from_str_radix(s, 16).unwrap_or(fallback);
                let r = (n >> 8) & 0xf;
                let g = (n >> 4) & 0xf;
                let b = n & 0xf;
                ((r | (r << 4)) << 16) | ((g | (g << 4)) << 8) | (b | (b << 4))
            } else {
                fallback
            }
        }
        _ => fallback,
    }
}

/// 颜色 → "#rrggbb" 展示串
fn color_to_hex_string(c: i64) -> String {
    format!("#{:06x}", c & 0xffffff)
}

fn num(v: Option<&Value>, fb: f64) -> f64 {
    v.and_then(Value::as_f64).unwrap_or(fb)
}

fn unit(v: Option<&Value>, fb: f64) -> f64 {
    num(v, fb).clamp(0.0, 1.0)
}

fn bool_or(v: Option<&Value>, fb: bool) -> bool {
    v.and_then(Value::as_bool).unwrap_or(fb)
}

fn str_or(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).unwrap_or("").to_string()
}

/// 从任意 JSON 对象读取材质参数（缺失字段回退默认；与前端 materialParamsFrom 同构）
pub fn material_params_from(o: &Map<String, Value>) -> MaterialParams {
    let d = MaterialParams::default();
    MaterialParams {
        color: parse_color_hex(o.get("color").unwrap_or(&Value::Null), d.color),
        metalness: unit(o.get("metalness"), d.metalness),
        roughness: unit(o.get("roughness"), d.roughness),
        specular_intensity: unit(o.get("specularIntensity"), d.specular_intensity),
        specular_color: parse_color_hex(o.get("specularColor").unwrap_or(&Value::Null), d.specular_color),
        ior: num(o.get("ior"), d.ior).clamp(1.0, 2.333),
        emissive: parse_color_hex(o.get("emissive").unwrap_or(&Value::Null), d.emissive),
        emissive_intensity: num(o.get("emissiveIntensity"), d.emissive_intensity).clamp(0.0, 10.0),
        emission_enabled: bool_or(o.get("emissionEnabled"), d.emission_enabled),
        clearcoat: unit(o.get("clearcoat"), d.clearcoat),
        clearcoat_roughness: unit(o.get("clearcoatRoughness"), d.clearcoat_roughness),
        clearcoat_enabled: bool_or(o.get("clearcoatEnabled"), d.clearcoat_enabled),
        sheen: unit(o.get("sheen"), d.sheen),
        sheen_color: parse_color_hex(o.get("sheenColor").unwrap_or(&Value::Null), d.sheen_color),
        sheen_roughness: unit(o.get("sheenRoughness"), d.sheen_roughness),
        sheen_enabled: bool_or(o.get("sheenEnabled"), d.sheen_enabled),
        transmission: unit(o.get("transmission"), d.transmission),
        thickness: num(o.get("thickness"), d.thickness).clamp(0.0, 100.0),
        attenuation_color: parse_color_hex(o.get("attenuationColor").unwrap_or(&Value::Null), d.attenuation_color),
        attenuation_distance: num(o.get("attenuationDistance"), d.attenuation_distance).clamp(0.0, 10.0),
        transmission_enabled: bool_or(o.get("transmissionEnabled"), d.transmission_enabled),
        anisotropy: unit(o.get("anisotropy"), d.anisotropy),
        anisotropy_rotation: unit(o.get("anisotropyRotation"), d.anisotropy_rotation),
        iridescence: unit(o.get("iridescence"), d.iridescence),
        iridescence_ior: num(o.get("iridescenceIOR"), d.iridescence_ior).clamp(1.0, 2.333),
        opacity: unit(o.get("opacity"), d.opacity),
        alpha_clip_threshold: unit(o.get("alphaClipThreshold"), d.alpha_clip_threshold),
        wireframe: bool_or(o.get("wireframe"), d.wireframe),
        toon_steps: num(o.get("toonSteps"), d.toon_steps as f64).round().clamp(2.0, 6.0) as i64,
        toon_shadow_strength: unit(o.get("toonShadowStrength"), d.toon_shadow_strength),
        outline_enabled: bool_or(o.get("outlineEnabled"), d.outline_enabled),
        outline_color: parse_color_hex(o.get("outlineColor").unwrap_or(&Value::Null), d.outline_color),
        outline_width: num(o.get("outlineWidth"), d.outline_width).clamp(0.0, 0.1),
        map: str_or(o.get("map")),
        metalness_map: str_or(o.get("metalnessMap")),
        roughness_map: str_or(o.get("roughnessMap")),
        normal_map: str_or(o.get("normalMap")),
        emissive_map: str_or(o.get("emissiveMap")),
    }
}

/// 内置默认着色器引用（.mat shader 字段缺省写入值；与 public/internal/shaders 一致）
pub(crate) const DEFAULT_SHADER_REL: &str = "internal/shaders/PBR.shader";

/// 着色器种类归一（未知/空值回退 physical；与前端 normalizeShaderKind 一致）。
/// 天空程序：skyprocedural（大气散射）/ skycube（立方体贴图天空盒）。
pub(crate) fn normalize_shader_kind(kind: &str) -> &'static str {
    match kind.trim() {
        "unlit" => "unlit",
        "toon" => "toon",
        "skyprocedural" => "skyprocedural",
        "skycube" => "skycube",
        _ => "physical",
    }
}

/// 内置天空着色器引用（天空材质 shader 字段的正形值）
pub const SKY_PROCEDURAL_SHADER_REL: &str = "internal/shaders/SkyProcedural.shader";
pub const SKY_CUBE_SHADER_REL: &str = "internal/shaders/SkyBox.shader";

// ---------------------------------------------------------------------------
// .shader = Unity ShaderLab 风格着色器源码（渲染程序资产，材质经 shader 字段引用）。
// TVE 引擎不编译这份源码，而是按 pragma 识别渲染分支（与内置 three 材质管线映射）：
//   `#pragma surface surf Standard` → physical（PBR）
//   `#pragma surface surf Toon`     → toon（卡通）
//   无 surface pragma、仅顶点片元（#pragma fragment）→ unlit
// Properties 只声明暴露项（与材质检查器的参数分组对应）；参数值存于材质资产。
// ---------------------------------------------------------------------------

const SHADER_HEADER: &str = "\
// TVE 着色器（Unity ShaderLab 风格源文件；.shader = 渲染程序，材质 .mat 通过 shader 字段引用它）
// TVE 引擎按 pragma 识别渲染分支：surface + Standard → PBR / surface + Toon → 卡通 / 仅顶点片元 → Unlit；
// 具体参数值存于材质资产（.mat），本文件的 Properties 只声明暴露项。
";

const PBR_SHADER_TEMPLATE: &str = r##"// TVE 着色器（Unity ShaderLab 风格源文件；.shader = 渲染程序，材质 .mat 通过 shader 字段引用它）
// TVE 引擎按 pragma 识别渲染分支：surface + Standard → PBR / surface + Toon → 卡通 / 仅顶点片元 → Unlit；
// 具体参数值存于材质资产（.mat），本文件的 Properties 只声明暴露项。
Shader "{NAME}"
{
    Properties
    {
        _Color ("Base Color", Color) = (0.604, 0.643, 0.698, 1)
        _MainTex ("Base Color Texture", 2D) = "white" {}
        _Metallic ("Metallic", Range(0, 1)) = 0.1
        _Roughness ("Roughness", Range(0, 1)) = 0.75
        _EmissionColor ("Emission Color", Color) = (0, 0, 0, 1)
        _EmissionIntensity ("Emission Strength", Range(0, 10)) = 1
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" }
        LOD 200

        CGPROGRAM
        // 原理化 BSDF（对齐 Blender Principled BSDF），完整物理光照
        #pragma surface surf Standard fullforwardshadows
        #pragma target 3.0

        sampler2D _MainTex;
        fixed4 _Color;
        half _Metallic;
        half _Roughness;
        fixed4 _EmissionColor;
        half _EmissionIntensity;

        struct Input
        {
            float2 uv_MainTex;
        };

        void surf (Input IN, inout SurfaceOutputStandard o)
        {
            fixed4 c = tex2D (_MainTex, IN.uv_MainTex) * _Color;
            o.Albedo = c.rgb;
            o.Metallic = _Metallic;
            o.Smoothness = 1 - _Roughness;
            o.Emission = _EmissionColor.rgb * _EmissionIntensity;
            o.Alpha = c.a;
        }
        ENDCG
    }
    FallBack "VertexLit"
}
"##;

const UNLIT_SHADER_TEMPLATE: &str = r##"// TVE 着色器（Unity ShaderLab 风格源文件；.shader = 渲染程序，材质 .mat 通过 shader 字段引用它）
// TVE 引擎按 pragma 识别渲染分支：surface + Standard → PBR / surface + Toon → 卡通 / 仅顶点片元 → Unlit；
// 具体参数值存于材质资产（.mat），本文件的 Properties 只声明暴露项。
Shader "{NAME}"
{
    Properties
    {
        _Color ("Base Color", Color) = (1, 1, 1, 1)
        _MainTex ("Base Color Texture", 2D) = "white" {}
        _Opacity ("Opacity", Range(0, 1)) = 1
        _AlphaClip ("Alpha Clip Threshold", Range(0, 1)) = 0.5
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" }
        LOD 100

        CGPROGRAM
        // 无光照直出（不受光照影响，适合 UI 面、标志、风格化场景）
        #pragma vertex vert
        #pragma fragment frag
        #pragma target 2.0

        sampler2D _MainTex;
        fixed4 _Color;
        fixed _Opacity;
        fixed _AlphaClip;

        struct appdata
        {
            float4 vertex : POSITION;
            float2 uv : TEXCOORD0;
        };

        struct v2f
        {
            float4 pos : SV_POSITION;
            float2 uv : TEXCOORD0;
        };

        v2f vert (appdata v)
        {
            v2f o;
            o.pos = UnityObjectToClipPos(v.vertex);
            o.uv = v.uv;
            return o;
        }

        fixed4 frag (v2f i) : SV_Target
        {
            fixed4 c = tex2D (_MainTex, i.uv) * _Color;
            if (_AlphaClip > 0.001) clip(c.a - _AlphaClip);
            c.a *= _Opacity;
            return c;
        }
        ENDCG
    }
    FallBack "Unlit/Texture"
}
"##;

const TOON_SHADER_TEMPLATE: &str = r##"// TVE 着色器（Unity ShaderLab 风格源文件；.shader = 渲染程序，材质 .mat 通过 shader 字段引用它）
// TVE 引擎按 pragma 识别渲染分支：surface + Standard → PBR / surface + Toon → 卡通 / 仅顶点片元 → Unlit；
// 具体参数值存于材质资产（.mat），本文件的 Properties 只声明暴露项。
Shader "{NAME}"
{
    Properties
    {
        _Color ("Base Color", Color) = (1, 1, 1, 1)
        _MainTex ("Base Color Texture", 2D) = "white" {}
        _ToonSteps ("Toon Steps", Range(2, 6)) = 3
        _ToonShadowStrength ("Shadow Strength", Range(0, 1)) = 0.6
        _EmissionColor ("Emission Color", Color) = (0, 0, 0, 1)
        _EmissionIntensity ("Emission Strength", Range(0, 10)) = 1
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" }
        LOD 200

        CGPROGRAM
        // 卡通分档光照（cel shading）；轮廓描边由引擎以独立背面外扩 pass 实现
        #pragma surface surf Toon fullforwardshadows
        #pragma target 3.0

        sampler2D _MainTex;
        fixed4 _Color;
        half _ToonSteps;
        half _ToonShadowStrength;
        fixed4 _EmissionColor;
        half _EmissionIntensity;

        struct Input
        {
            float2 uv_MainTex;
        };

        void surf (Input IN, inout SurfaceOutput o)
        {
            fixed4 c = tex2D (_MainTex, IN.uv_MainTex) * _Color;
            o.Albedo = c.rgb;
            o.Emission = _EmissionColor.rgb * _EmissionIntensity;
            o.Alpha = c.a;
        }

        // 分档漫反射：N·L 量化为 _ToonSteps 档，最暗档亮度 = 1 − _ToonShadowStrength
        half4 LightingToon (SurfaceOutput s, half3 lightDir, half atten)
        {
            half nd = dot (s.Normal, lightDir) * 0.5 + 0.5;
            half steps = max (2, _ToonSteps);
            half level = floor (nd * steps) / steps;
            half darkest = 1 - _ToonShadowStrength;
            half shade = darkest + level * (1 - darkest);
            half4 c;
            c.rgb = s.Albedo * _LightColor0.rgb * shade * atten;
            c.a = s.Alpha;
            return c;
        }
        ENDCG
    }
    FallBack "VertexLit"
}
"##;

// 天空程序（Unity 天空盒着色器惯例）：Tags 携带 "PreviewType"="Skybox" 标记，
// TVE 引擎据此与材质 .mat 的 kind 字段映射渲染（skyprocedural→大气散射 / skycube→立方体贴图）。

const SKY_PROCEDURAL_SHADER_TEMPLATE: &str = r##"// TVE 着色器（Unity ShaderLab 风格源文件；.shader = 渲染程序，材质 .mat 通过 shader 字段引用它）
// 天空程序：PreviewType=Skybox 标签 + _SUNDISK 关键字标记程序化大气散射
// （TVE 引擎内为透射 LUT + 多重散射双 pass 的等价实现，对齐 Blender 天空纹理）。
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
        // Nishita 大气散射（Blender 天空纹理风格）：太阳方向由高度角/方位角给出，
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

const SKY_CUBE_SHADER_TEMPLATE: &str = r##"// TVE 着色器（Unity ShaderLab 风格源文件；.shader = 渲染程序，材质 .mat 通过 shader 字段引用它）
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

/// 着色器文档 → .shader 源码（Unity ShaderLab 风格；kind 决定模板）。
/// rel 为着色器资产相对路径：Shader 指令名 = 路径去扩展名，保证与资产位置一致。
pub fn serialize_shader_file(rel: &str, kind: &str) -> String {
    let template = match normalize_shader_kind(kind) {
        "unlit" => UNLIT_SHADER_TEMPLATE,
        "toon" => TOON_SHADER_TEMPLATE,
        "skyprocedural" => SKY_PROCEDURAL_SHADER_TEMPLATE,
        "skycube" => SKY_CUBE_SHADER_TEMPLATE,
        _ => PBR_SHADER_TEMPLATE,
    };
    template.replace("{NAME}", &shader_directive_name(rel))
}

/// .shader 指令名 = 资产相对路径去扩展名（如 "internal/shaders/PBR.shader" →
/// "internal/shaders/PBR"），保证 Shader "…" 与资产路径始终一致
pub(crate) fn shader_directive_name(rel: &str) -> String {
    let rel = rel.trim().replace('\\', "/");
    let stem = rel.strip_suffix(SHADER_EXT).unwrap_or(&rel);
    stem.to_string()
}

/// 把资产（.shader 文件，或目录下全部 .shader）的 Shader 指令改写为与当前
/// 路径一致——复制/导入/移动/重命名后调用，指令随位置跟随。
/// 非着色器文档跳过；改写失败不报错（跟随改写是尽力而为的元数据修正）。
pub(crate) fn rewrite_shader_directive(root: &Path, rel: &str) {
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
            } else if name.to_ascii_lowercase().ends_with(SHADER_EXT) {
                rewrite_shader_directive(root, &child_rel);
            }
        }
        return;
    }
    if !rel.to_ascii_lowercase().ends_with(SHADER_EXT) {
        return;
    }
    let Ok(text) = std::fs::read_to_string(&target) else {
        return;
    };
    // 仅改写可解析的着色器（外部任意 ShaderLab 也支持；无 Shader 指令行则不动）
    if parse_shader_doc(&text).is_none() {
        return;
    }
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
        return;
    }
    let mut new_text = out.join("\n");
    new_text.push('\n');
    if new_text != text.replace("\r\n", "\n") {
        let _ = std::fs::write(&target, new_text);
    }
}

/// 解析 .shader 源文本 → (name, kind)；非着色器文档返回 None。
/// - name：首个 `Shader "Group/Name"` 指令（去掉组前缀）；
/// - kind：surface 光照模型（Toon→toon / Standard→physical / 其余 surface 归 physical），
///   无 surface pragma 但有 `#pragma fragment/vertex`（顶点片元无光照）→ unlit；
/// 另兼容旧版 JSON 格式（$type=shader，早期内部实现遗留）。
pub(crate) fn parse_shader_doc(text: &str) -> Option<(String, String)> {
    let trimmed = text.trim_start();
    if trimmed.starts_with('{') {
        let v: Value = serde_json::from_str(text).ok()?;
        let o = v.as_object()?;
        if o.get("$type").and_then(Value::as_str) != Some("shader") {
            return None;
        }
        let name = o
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("Shader")
            .to_string();
        let kind = o
            .get("kind")
            .and_then(Value::as_str)
            .map(normalize_shader_kind)
            .unwrap_or("physical");
        return Some((name, kind.to_string()));
    }
    let mut name: Option<String> = None;
    // 天空程序（Unity 天空盒惯例 PreviewType=Skybox 标签）：_SUNDISK → 程序化散射 /
    // samplerCUBE → 立方体贴图。先于 pragma 检查（天空是顶点片元着色器，否则误判 unlit）。
    let mut kind: Option<String> = if text.contains(r#""PreviewType"="Skybox""#) {
        Some(
            if text.contains("samplerCUBE") {
                "skycube"
            } else {
                "skyprocedural"
            }
            .to_string(),
        )
    } else {
        None
    };
    for line in text.lines() {
        let t = line.trim();
        if name.is_none() {
            if let Some(rest) = t.strip_prefix("Shader ").or_else(|| t.strip_prefix("shader ")) {
                let rest = rest.trim_start();
                if let Some(quoted) = rest.strip_prefix('"') {
                    if let Some(end) = quoted.find('"') {
                        let full = &quoted[..end];
                        let bare = full.rsplit('/').next().unwrap_or(full);
                        name = Some(bare.trim().to_string());
                    }
                }
            }
        }
        if kind.is_none() {
            if let Some(rest) = t.strip_prefix("#pragma") {
                let rest = rest.trim_start();
                if let Some(rest) = rest.strip_prefix("surface") {
                    // #pragma surface <surfFunc> <lightingModel> [options]
                    let mut it = rest.split_whitespace();
                    let _func = it.next();
                    kind = Some(
                        match it.next().unwrap_or("").to_ascii_lowercase().as_str() {
                            "toon" => "toon",
                            _ => "physical",
                        }
                        .to_string(),
                    );
                } else if rest.starts_with("fragment") || rest.starts_with("vertex") {
                    kind = Some("unlit".to_string());
                }
            }
        }
        if name.is_some() && kind.is_some() {
            break;
        }
    }
    Some((name?, kind.unwrap_or_else(|| "physical".to_string())))
}

/// 材质文档 → .mat 文件内容（字段顺序与前端 serializeMaterialFile 一致）：
/// shader 非空写 shader 字段（材质 ↔ 着色器分离后的正形），否则回退写
/// materialType（旧格式兼容：迁移产物/旧项目重复制保留原引用方式）。
pub fn serialize_material_file(name: &str, shader: &str, fallback_type: &str, p: &MaterialParams) -> String {
    let mut v = serde_json::Map::new();
    v.insert("$type".into(), Value::String("material".into()));
    v.insert("$ver".into(), Value::from(1));
    v.insert("name".into(), Value::String(name.to_string()));
    if shader.trim().is_empty() {
        v.insert(
            "materialType".into(),
            Value::String(if fallback_type.trim().is_empty() {
                "physical".to_string()
            } else {
                fallback_type.to_string()
            }),
        );
    } else {
        v.insert("shader".into(), Value::String(shader.to_string()));
    }
    v.insert("color".into(), Value::String(color_to_hex_string(p.color)));
    v.insert("metalness".into(), Value::from(p.metalness));
    v.insert("roughness".into(), Value::from(p.roughness));
    v.insert("specularIntensity".into(), Value::from(p.specular_intensity));
    v.insert("specularColor".into(), Value::String(color_to_hex_string(p.specular_color)));
    v.insert("ior".into(), Value::from(p.ior));
    v.insert("emissive".into(), Value::String(color_to_hex_string(p.emissive)));
    v.insert("emissiveIntensity".into(), Value::from(p.emissive_intensity));
    v.insert("emissionEnabled".into(), Value::Bool(p.emission_enabled));
    v.insert("clearcoat".into(), Value::from(p.clearcoat));
    v.insert("clearcoatRoughness".into(), Value::from(p.clearcoat_roughness));
    v.insert("clearcoatEnabled".into(), Value::Bool(p.clearcoat_enabled));
    v.insert("sheen".into(), Value::from(p.sheen));
    v.insert("sheenColor".into(), Value::String(color_to_hex_string(p.sheen_color)));
    v.insert("sheenRoughness".into(), Value::from(p.sheen_roughness));
    v.insert("sheenEnabled".into(), Value::Bool(p.sheen_enabled));
    v.insert("transmission".into(), Value::from(p.transmission));
    v.insert("thickness".into(), Value::from(p.thickness));
    v.insert("attenuationColor".into(), Value::String(color_to_hex_string(p.attenuation_color)));
    v.insert("attenuationDistance".into(), Value::from(p.attenuation_distance));
    v.insert("transmissionEnabled".into(), Value::Bool(p.transmission_enabled));
    v.insert("anisotropy".into(), Value::from(p.anisotropy));
    v.insert("anisotropyRotation".into(), Value::from(p.anisotropy_rotation));
    v.insert("iridescence".into(), Value::from(p.iridescence));
    v.insert("iridescenceIOR".into(), Value::from(p.iridescence_ior));
    v.insert("opacity".into(), Value::from(p.opacity));
    v.insert("alphaClipThreshold".into(), Value::from(p.alpha_clip_threshold));
    v.insert("wireframe".into(), Value::Bool(p.wireframe));
    v.insert("toonSteps".into(), Value::from(p.toon_steps));
    v.insert("toonShadowStrength".into(), Value::from(p.toon_shadow_strength));
    v.insert("outlineEnabled".into(), Value::Bool(p.outline_enabled));
    v.insert("outlineColor".into(), Value::String(color_to_hex_string(p.outline_color)));
    v.insert("outlineWidth".into(), Value::from(p.outline_width));
    v.insert("map".into(), Value::String(p.map.clone()));
    v.insert("metalnessMap".into(), Value::String(p.metalness_map.clone()));
    v.insert("roughnessMap".into(), Value::String(p.roughness_map.clone()));
    v.insert("normalMap".into(), Value::String(p.normal_map.clone()));
    v.insert("emissiveMap".into(), Value::String(p.emissive_map.clone()));
    serde_json::to_string_pretty(&Value::Object(v)).unwrap_or_default()
}

/// 天空盒材质序列化（.mat 中 shader=天空着色器引用的特殊材质）：
/// - cube：持有 TextureCube 引用（cubeMap）+ 旋转/强度/世界不透明度/模糊；
/// - procedural：三段配色；
/// shader 字段引用内置天空着色器资产（材质 ↔ 着色器分离）；kind 为渲染快照
/// 判别字段（与旧格式一致，读取端以 kind 优先）。kind 未知值归一为 cube。
pub fn serialize_sky_material_file(name: &str, kind: &str) -> String {
    let procedural = kind.trim() == "procedural";
    let v = json!({
        "$type": "material",
        "$ver": 1,
        "name": sanitize_asset_stem(name),
        "shader": if procedural { SKY_PROCEDURAL_SHADER_REL } else { SKY_CUBE_SHADER_REL },
        "kind": if procedural { "procedural" } else { "cube" },
        // cube 专属：TextureCube 引用 + 渲染参数（默认与引擎兜底一致）
        "cubeMap": "internal/skybox/DefaultSkybox.texcube",
        "rotation": 0,
        "strength": 1,
        "worldOpacity": 0,
        "blur": 0,
        // procedural 专属：Blender 天空纹理风格参数
        "sunDisc": true,
        "sunSize": 1.0,
        "sunStrength": 1.0,
        "sunElevation": 25.0,
        "sunRotation": 0.0,
        "altitude": 0,
        "air": 1.0,
        "dust": 1.0,
        "ozone": 1.0,
        "ms": true,
        "color": "#9aa4b2",
        "metalness": 0,
        "roughness": 1,
        "emissive": "#000000",
        "wireframe": false,
    });
    let mut text = serde_json::to_string_pretty(&v).unwrap_or_default();
    text.push('\n');
    text
}

/// 资产名规范化（去扩展名/非法字符；空值回退 "Material"）
pub(crate) fn sanitize_asset_stem(raw: &str) -> String {
    let trimmed = raw.trim();
    let stem = match trimmed.rfind('.') {
        Some(i) if i > 0 => &trimmed[..i],
        _ => trimmed,
    };
    let cleaned: String = stem
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            c => c,
        })
        .collect();
    let collapsed: String = collapsed_spaces(&cleaned);
    let trimmed_again = collapsed.trim_start_matches('.').trim().to_string();
    if trimmed_again.is_empty() {
        "Material".to_string()
    } else {
        trimmed_again
    }
}

fn collapsed_spaces(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pending_space = false;
    for c in s.chars() {
        if c == ' ' {
            pending_space = true;
        } else {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.push(c);
        }
    }
    out
}

/// 在 assets/materials 下建议一个不冲突的 .mat 相对路径
pub(crate) fn suggest_material_rel(taken: &[String], stem: &str) -> String {
    let base = sanitize_asset_stem(stem);
    let used: std::collections::HashSet<String> = taken
        .iter()
        .map(|r| r.to_lowercase())
        .collect();
    let mut name = base.clone();
    let mut n = 2;
    while used.contains(&format!("assets/materials/{name}{MATERIAL_EXT}").to_lowercase()) {
        name = format!("{base} {n}");
        n += 1;
    }
    format!("assets/materials/{name}{MATERIAL_EXT}")
}

/// 遍历场景 JSON 收集 meshNode/skyboxNode 的材质资产引用（去重、忽略空）。
/// skyboxNode 的 .mat（天空材质）随导出：player 据此渲染天空贴图/参数。
pub fn collect_material_refs(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Array(items) => {
            for item in items {
                collect_material_refs(item, out);
            }
        }
        Value::Object(o) => {
            let ty = o.get("type").and_then(Value::as_str);
            if ty == Some("meshNode") || ty == Some("skyboxNode") {
                if let Some(Value::String(rel)) = o.get("material") {
                    if !rel.is_empty() && !out.contains(rel) {
                        out.push(rel.clone());
                    }
                }
            }
            if let Some(children) = o.get("children") {
                collect_material_refs(children, out);
            }
            if let Some(root) = o.get("root") {
                collect_material_refs(root, out);
            }
        }
        _ => {}
    }
}

/// 遍历场景 JSON 收集模型网格的模型资产引用（去重；按扩展名过滤）
pub fn collect_model_refs(v: &Value, out: &mut Vec<String>) {
    fn is_model_rel(rel: &str) -> bool {
        let ext = rel.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        matches!(ext.as_str(), "glb" | "gltf" | "fbx" | "obj") && rel.contains('.')
    }
    match v {
        Value::Array(items) => {
            for item in items {
                collect_model_refs(item, out);
            }
        }
        Value::Object(o) => {
            if o.get("type").and_then(Value::as_str) == Some("meshNode")
                && o.get("source").and_then(Value::as_str) == Some("model")
            {
                if let Some(Value::String(rel)) = o.get("model") {
                    if is_model_rel(rel) && !out.contains(rel) {
                        out.push(rel.clone());
                    }
                }
            }
            if let Some(children) = o.get("children") {
                collect_model_refs(children, out);
            }
            if let Some(root) = o.get("root") {
                collect_model_refs(root, out);
            }
        }
        _ => {}
    }
}

/// 遍历场景 JSON 收集天空盒节点的 TextureCube（.texcube）资产引用（去重、忽略空）
pub fn collect_texcube_refs(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Array(items) => {
            for item in items {
                collect_texcube_refs(item, out);
            }
        }
        Value::Object(o) => {
            if o.get("type").and_then(Value::as_str) == Some("skyboxNode") {
                if let Some(Value::String(rel)) = o.get("cubeMap") {
                    if !rel.is_empty() && !out.contains(rel) {
                        out.push(rel.clone());
                    }
                }
            }
            if let Some(children) = o.get("children") {
                collect_texcube_refs(children, out);
            }
            if let Some(root) = o.get("root") {
                collect_texcube_refs(root, out);
            }
        }
        _ => {}
    }
}

/// 遍历场景 JSON 收集音源节点的音频资产引用（去重、按扩展名过滤）
pub fn collect_audio_refs(v: &Value, out: &mut Vec<String>) {
    fn is_audio_rel(rel: &str) -> bool {
        let ext = rel.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        matches!(ext.as_str(), "mp3" | "wav" | "ogg" | "m4a" | "aac" | "flac") && rel.contains('.')
    }
    match v {
        Value::Array(items) => {
            for item in items {
                collect_audio_refs(item, out);
            }
        }
        Value::Object(o) => {
            if o.get("type").and_then(Value::as_str) == Some("audioNode") {
                if let Some(Value::String(rel)) = o.get("audio").and_then(|a| a.get("source")) {
                    if is_audio_rel(rel) && !out.contains(rel) {
                        out.push(rel.clone());
                    }
                }
            }
            if let Some(children) = o.get("children") {
                collect_audio_refs(children, out);
            }
            if let Some(root) = o.get("root") {
                collect_audio_refs(root, out);
            }
        }
        _ => {}
    }
}

/// 旧 meshNode 是否携带内嵌材质参数（material 非字符串且存在任一 legacy 字段）
fn legacy_params_of(o: &Map<String, Value>) -> Option<MaterialParams> {
    if matches!(o.get("material"), Some(Value::String(_))) {
        return None;
    }
    if !LEGACY_KEYS.iter().any(|k| o.contains_key(*k)) {
        return None;
    }
    Some(material_params_from(o))
}

fn legacy_signature(p: &MaterialParams) -> String {
    format!(
        "{:x}|{}|{}|{:x}|{}",
        p.color, p.metalness, p.roughness, p.emissive, p.wireframe
    )
}

fn legacy_is_default(p: &MaterialParams) -> bool {
    let d = MaterialParams::default();
    p.color == d.color
        && p.metalness == d.metalness
        && p.roughness == d.roughness
        && p.emissive == d.emissive
        && p.wireframe == d.wireframe
}

/// 写 .mat 资产到项目（建目录 + 补 .meta；与 write_text 命令同语义）
pub(crate) fn write_material_asset(root: &Path, rel: &str, content: &str) -> Result<(), String> {
    let p = crate::project::resolve_in_root(root, rel)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, content).map_err(|e| format!("写入失败 '{rel}': {e}"))?;
    if crate::project::is_meta_candidate(root, rel) {
        let _ = crate::project::ensure_meta(&p);
    }
    Ok(())
}

/// 递归改写旧节点（内嵌材质 → 材质资产引用），必要时落盘 .mat
fn walk_legacy(v: &mut Value, root: &Path, taken: &mut Vec<String>, sigs: &mut HashMap<String, String>) -> Result<(), String> {
    match v {
        Value::Array(items) => {
            for item in items {
                walk_legacy(item, root, taken, sigs)?;
            }
        }
        Value::Object(o) => {
            if o.get("type").and_then(Value::as_str) == Some("meshNode") {
                if let Some(legacy) = legacy_params_of(o) {
                    if legacy_is_default(&legacy) {
                        o.insert("material".into(), Value::String(DEFAULT_MATERIAL_REL.into()));
                    } else {
                        let sig = legacy_signature(&legacy);
                        let rel = match sigs.get(&sig) {
                            Some(rel) => rel.clone(),
                            None => {
                                let node_name = o
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .unwrap_or("Material");
                                let rel = suggest_material_rel(taken, node_name);
                                let stem = sanitize_asset_stem(node_name);
                                write_material_asset(
                                    root,
                                    &rel,
                                    &serialize_material_file(&stem, DEFAULT_SHADER_REL, "physical", &legacy),
                                )?;
                                taken.push(rel.clone());
                                sigs.insert(sig, rel.clone());
                                rel
                            }
                        };
                        o.insert("material".into(), Value::String(rel));
                    }
                }
            }
            if let Some(children) = o.get_mut("children") {
                walk_legacy(children, root, taken, sigs)?;
            }
            if let Some(root_node) = o.get_mut("root") {
                walk_legacy(root_node, root, taken, sigs)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// 迁移旧版场景文档（内嵌材质 → 材质资产引用）。
/// 返回是否发生改写；写盘失败返回 Err（调用方决定是否按原内容装载）。
pub fn migrate_legacy_scene(root: &Path, doc: &mut Value) -> Result<bool, String> {
    // 收集磁盘已有 .mat 资产名，避免生成同名覆盖
    let mut taken: Vec<String> = Vec::new();
    if let Ok(entries) = crate::project::scan_tree(root) {
        taken.extend(entries.into_iter().filter(|e| e.kind == "mat").map(|e| e.path));
    }
    let mut sigs = HashMap::new();
    let before = doc.to_string();
    walk_legacy(doc, root, &mut taken, &mut sigs)?;
    Ok(doc.to_string() != before)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn params_from_defaults_and_clamps() {
        let mut o = Map::new();
        o.insert("color".into(), json!("#ff8800"));
        o.insert("metalness".into(), json!(2.0)); // 超界收敛到 1
        o.insert("roughness".into(), json!(-1.0)); // 收敛到 0
        let p = material_params_from(&o);
        assert_eq!(p.color, 0xff8800);
        assert_eq!(p.metalness, 1.0);
        assert_eq!(p.roughness, 0.0);
        assert_eq!(p.ior, 1.5); // 缺失回退默认
    }

    /// IPC（material_write 参数）与 .mat 文件共用 three.js 键 iridescenceIOR；
    /// serde camelCase 默认会把 ior 规整成 Ior，须由字段级 rename 钉住。
    #[test]
    fn ipc_roundtrip_keeps_iridescence_ior_key() {
        let v = serde_json::to_value(MaterialParams::default()).unwrap();
        assert!(
            v.get("iridescenceIOR").is_some(),
            "IPC 材质参数必须带 three.js 键 iridescenceIOR（实际: {v}）"
        );
        assert!(v.get("iridescenceIor").is_none());
        let back: MaterialParams =
            serde_json::from_value(serde_json::json!({ "iridescenceIOR": 1.3 })).unwrap();
        assert_eq!(back.iridescence_ior, 1.3);
        assert_eq!(back.color, MaterialParams::default().color); // 其余字段走 default
    }

    #[test]
    fn collect_refs_walks_children_and_wrapper() {
        let doc = json!({
            "type": "scene",
            "root": {
                "type": "node", "id": "r",
                "children": [
                    { "type": "meshNode", "id": "a", "source": "primitive", "material": "internal/materials/Default.mat" },
                    { "type": "meshNode", "id": "b", "source": "model", "model": "assets/models/x.glb", "material": "assets/materials/M.mat" }
                ]
            }
        });
        let mut mats = Vec::new();
        collect_material_refs(&doc, &mut mats);
        assert_eq!(mats.len(), 2);
        let mut models = Vec::new();
        collect_model_refs(&doc, &mut models);
        assert_eq!(models, vec!["assets/models/x.glb".to_string()]);
    }

    #[test]
    fn migrate_rewrites_legacy_and_writes_mat() {
        let dir = std::env::temp_dir().join(format!("tve-migrate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let mut doc = json!({
            "type": "scene",
            "root": {
                "type": "node", "id": "r", "name": "Root",
                "children": [
                    { "type": "meshNode", "id": "a", "name": "Box A", "color": "#ff0000", "metalness": 0.5 },
                    { "type": "meshNode", "id": "b", "name": "Box B", "color": "#ff0000", "metalness": 0.5 },
                    { "type": "meshNode", "id": "c", "name": "Default Like" }
                ]
            }
        });
        let changed = migrate_legacy_scene(&dir, &mut doc).unwrap();
        assert!(changed);
        // 非默认内嵌 → 生成 .mat 并改写引用；两节点同签名共享同一资产
        let a = &doc["root"]["children"][0];
        let b = &doc["root"]["children"][1];
        assert_eq!(a["material"], b["material"]);
        let rel = a["material"].as_str().unwrap();
        assert!(rel.starts_with("assets/materials/"));
        assert!(dir.join(rel).is_file());
        // 新格式节点（无内嵌字段）不被改写
        assert!(doc["root"]["children"][2].get("material").is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
