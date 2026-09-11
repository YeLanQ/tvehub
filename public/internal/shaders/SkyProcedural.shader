// TVE 天空程序（内置资产；由天空材质引用，无效果着色器入口）
// 天空程序：PreviewType=Skybox 标签 + _SUNDISK 关键字标记程序化大气散射
// （TVE 引擎内为透射 LUT + 多重散射双 pass 的等价实现）。
Shader "internal/shaders/SkyProcedural"
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
