// TVE 着色器（ShaderLab 风格源文件；.shader = 渲染程序，材质 .mat 通过 shader 字段引用它）
// TVE 引擎按 pragma 识别渲染分支：surface + Standard → PBR / surface + Toon → 卡通 / 仅顶点片元 → Unlit；
// 具体参数值存于材质资产（.mat），本文件的 Properties 只声明暴露项。
Shader "internal/shaders/Unlit"
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
