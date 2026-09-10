// @desc: 全息投影：菲涅尔边缘发光 + 横向扫描线，半透明双面（自定义着色器）
// TVE 自定义着色器示例（kind = custom）：把本文件复制到项目的 assets/shaders/ 后，
// 在材质卡片的「着色器」下拉里挂载它即可（Shader 指令名会随导入自动跟随路径）。
// 引擎拼接规则：CGINCLUDE（共享）+ 两个 CGPROGRAM 块（顶点/片元），Properties 项由
// 引擎自动声明为 uniform；内置可用 _Time（秒）与 three 标准矩阵/相机位置。
Shader "effect/Hologram"
{
    Properties
    {
        _Color ("Hologram Color", Color) = (0.35, 0.85, 1, 1)
        _RimColor ("Rim Color", Color) = (0.6, 0.95, 1, 1)
        _Alpha ("Base Alpha", Range(0, 1)) = 0.35
        _RimPower ("Rim Power", Range(0.5, 8)) = 2.5
        _ScanDensity ("Scan Line Density", Range(1, 60)) = 16
        _ScanSpeed ("Scan Speed", Range(-4, 4)) = 0.6
        _ScanStrength ("Scan Strength", Range(0, 1)) = 0.35
    }
    SubShader
    {
        // 半透明投影：开混合、关深度写入、双面（能看到背面，符合全息观感）
        Tags { "Queue"="Transparent" "RenderType"="Transparent" "ZWrite"="Off" "Cull"="Off" }

        CGINCLUDE
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
        // 需要贴图：加 _MainTex ("Tex", 2D) = "white" {} 后取消下一行注释
        // vec4 tex = texture2D(_MainTex, vUv);
        vec4 frag()
        {
            // 菲涅尔：视线越掠过表面（边缘）越亮
            float rim = pow(1.0 - max(dot(normalize(vNormalW), normalize(vViewDirW)), 0.0), _RimPower);
            // 横向扫描线：沿 UV.y 移动的条纹
            float scan = sin((vUv.y + _Time * _ScanSpeed) * _ScanDensity * 6.2831853);
            scan = scan * 0.5 + 0.5;
            vec3 col = _Color.rgb + _RimColor.rgb * rim;
            float alpha = clamp(_Alpha + _RimColor.a * rim * 0.6 + scan * _ScanStrength * 0.4, 0.0, 1.0);
            return vec4(col * (0.85 + scan * _ScanStrength * 0.3), alpha);
        }
        ENDCG
    }
    FallBack "Diffuse"
}
