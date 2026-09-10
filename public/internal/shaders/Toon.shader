// TVE 着色器（ShaderLab 风格源文件；.shader = 渲染程序，材质 .mat 通过 shader 字段引用它）
// TVE 引擎按 pragma 识别渲染分支：surface + Standard → PBR / surface + Toon → 卡通 / 仅顶点片元 → Unlit；
// 具体参数值存于材质资产（.mat），本文件的 Properties 只声明暴露项。
Shader "internal/shaders/Toon"
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
