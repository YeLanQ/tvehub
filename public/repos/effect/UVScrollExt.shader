// @desc: UV 流光：随时间滚动的能量条纹 + 颜色叠加（水面／能量流风格 · 效果着色器）
// TVE 效果着色器示例：复制到项目 assets/shaders/ 后，在材质卡片的「着色器」下拉里挂载。
// Base 声明本资产用的渲染分支（此处 PBR），Hook 块是叠加在其上的效果片段。
// 参数 _ScrollX / _ScrollY 控制条纹两轴滚动速度（可为负），_FlowDensity 控制条纹密度，
// _FlowColor / _FlowStrength 控制流光颜色与强度。
Shader "effect/UVScrollExt"
{
    Properties
    {
        _FlowColor ("Flow Color", Color) = (0.2, 0.85, 1, 1)
        _FlowStrength ("Flow Strength", Range(0, 4)) = 1.2
        _FlowDensity ("Flow Density", Range(1, 30)) = 6
        _ScrollX ("Scroll Speed X", Range(-4, 4)) = 0.35
        _ScrollY ("Scroll Speed Y", Range(-4, 4)) = 0.15
    }
    Base "PBR"

    // 钩子：在漫反射颜色计算后叠加流动条纹（颜色随两轴正弦交叉变化）
    // 可用变量：uv（纹理坐标）、_Time（运行秒数）、diffuseColor（漫反射颜色，可修改）
    Hook "Diffuse"
    {
        // 两轴正弦交叉得到流动的条纹图案（无贴图也有可见效果）
        float fx = sin((uv.x * _FlowDensity - _Time * _ScrollX) * 6.2831853);
        float fy = sin((uv.y * _FlowDensity + _Time * _ScrollY) * 6.2831853);
        float flow = fx * fy * 0.5 + 0.5;
        diffuseColor.rgb += _FlowColor.rgb * flow * _FlowStrength;
    }
}
