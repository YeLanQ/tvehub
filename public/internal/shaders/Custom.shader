// TVE 自定义着色器（GLSL 顶点/片元程序，kind = custom）
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
Shader "internal/shaders/Custom"
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
