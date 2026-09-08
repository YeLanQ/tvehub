// TVE 着色器（Unity ShaderLab 风格源文件；.shader = 渲染程序，材质 .mat 通过 shader 字段引用它）
// TVE 引擎按 pragma 识别渲染分支：surface + Standard → PBR / surface + Toon → 卡通 / 仅顶点片元 → Unlit；
// 具体参数值存于材质资产（.mat），本文件的 Properties 只声明暴露项。
Shader "internal/shaders/PBR"
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
