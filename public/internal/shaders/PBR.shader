// TVE 着色器（ShaderLab 风格；.shader = 效果着色器资产）
// 引擎的渲染分支只有三个出口：PBR / Unlit（无光照）/ 卡通；Base 决定本资产用哪个。
// - Properties：每一项自动成为材质面板的可调参数（值存材质 .mat 的 props 字段）
// - CGINCLUDE：共享工具函数（inline 到每个钩子之前）
// - Hook "…"：效果片段，注入到内置着色器的对应阶段（见下方可用钩子）
// 钩子内可用变量：normal（世界法线）/ viewDir（视线方向）/ uv / _Time（运行秒数）；
//   可修改变量按钩子而定（position / normal / diffuseColor / emissive / fragColor）
// 改完在资产检查器「编辑源码」里保存（Ctrl+S）即生效；详细说明见
// public/docs/editor/shaders.md。
Shader "internal/shaders/PBR"
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
