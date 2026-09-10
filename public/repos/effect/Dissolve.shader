// @desc: 溶解消失：噪声阈值裁剪 + 边缘发光，_Threshold 由 0 到 1 逐渐溶解
// TVE 自定义着色器示例（kind = custom）：复制到项目 assets/shaders/ 后挂到材质上。
// 玩法：把 _Threshold 从 0 调到 1 会让物体按噪声图案逐渐消失；边缘（阈值附近）发光。
// 若要随时间自动溶解，可在片元里用 _Time 改写阈值，例如：
//     float threshold = clamp(_Time * 0.2, 0.0, 1.0);
Shader "effect/Dissolve"
{
    Properties
    {
        _Color ("Base Color", Color) = (0.75, 0.78, 0.85, 1)
        _Threshold ("Dissolve Amount", Range(0, 1)) = 0.35
        _NoiseScale ("Noise Scale", Range(0.5, 40)) = 8
        _EdgeColor ("Edge Color", Color) = (1, 0.55, 0.1, 1)
        _EdgeWidth ("Edge Width", Range(0.001, 0.3)) = 0.06
        _EdgeIntensity ("Edge Intensity", Range(0, 8)) = 3
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" }

        CGINCLUDE
        varying vec2 vUv;

        // 值噪声（GLSL ES 1.00 兼容：无位运算、无 textureLod）
        float hash(vec2 p)
        {
            return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }

        float noise(vec2 p)
        {
            vec2 i = floor(p);
            vec2 f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                       mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
        }
        ENDCG

        CGPROGRAM
        #pragma vertex vert
        void vert()
        {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
        ENDCG

        CGPROGRAM
        #pragma fragment frag
        vec4 frag()
        {
            float n = noise(vUv * _NoiseScale);
            // 噪声低于阈值 = 已溶解：直接丢弃片元（alpha 裁剪，无需半透明混合）
            if (n < _Threshold) discard;
            vec4 base = _Color;
            // 阈值附近一条发光带：越靠近溶解边界越亮
            float edge = 1.0 - smoothstep(_Threshold, _Threshold + _EdgeWidth, n);
            return vec4(base.rgb + _EdgeColor.rgb * edge * _EdgeIntensity, base.a);
        }
        ENDCG
    }
    FallBack "Diffuse"
}
