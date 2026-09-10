// @desc: UV 流光：随时间滚动的能量条纹 + 颜色叠加（水面／能量流风格）
// TVE 自定义着色器示例（kind = custom）：复制到项目 assets/shaders/ 后挂到材质上。
// 参数 _ScrollX / _ScrollY 控制条纹两轴滚动速度（可为负），_FlowDensity 控制条纹密度，
// _FlowColor / _FlowStrength 控制流光颜色与强度。
Shader "effect/UVScroll"
{
    Properties
    {
        _Color ("Base Color", Color) = (0.05, 0.12, 0.3, 1)
        _FlowColor ("Flow Color", Color) = (0.2, 0.85, 1, 1)
        _FlowStrength ("Flow Strength", Range(0, 4)) = 1.2
        _FlowDensity ("Flow Density", Range(1, 30)) = 6
        _ScrollX ("Scroll Speed X", Range(-4, 4)) = 0.35
        _ScrollY ("Scroll Speed Y", Range(-4, 4)) = 0.15
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" }

        CGINCLUDE
        varying vec2 vUv;
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
        // 需要贴图：加 _MainTex ("Tex", 2D) = "white" {} 后取消下一行注释，
        // 并把采样结果乘进 base（滚动 UV 也一并作用在贴图上）
        // vec4 tex = texture2D(_MainTex, vUv + vec2(_Time * _ScrollX, _Time * _ScrollY));
        vec4 frag()
        {
            // 两轴正弦交叉得到流动的条纹图案（无贴图也有可见效果）
            float fx = sin((vUv.x * _FlowDensity - _Time * _ScrollX) * 6.2831853);
            float fy = sin((vUv.y * _FlowDensity + _Time * _ScrollY) * 6.2831853);
            float flow = fx * fy * 0.5 + 0.5;
            vec3 col = _Color.rgb + _FlowColor.rgb * flow * _FlowStrength;
            return vec4(col, 1.0);
        }
        ENDCG
    }
    FallBack "Diffuse"
}
