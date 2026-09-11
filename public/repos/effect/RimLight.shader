// @desc: 菲涅尔边缘光：在 PBR 基础上叠加视线掠射时的边缘发光（效果着色器 · PBR 分支）
// TVE 效果着色器示例：复制到项目 assets/shaders/ 后，在材质卡片的「着色器」下拉里挂载。
// Base 声明渲染分支（此处 PBR），Hook 块是叠加在其上的效果片段：注入到该分支的
// 自发光阶段——PBR 的光照/金属度/粗糙度全部保留。
// 玩法：调 _RimPower（边缘锐度）、_RimIntensity（强度）、_RimColor（颜色）即可。
Shader "effect/RimLight"
{
    Properties
    {
        _RimColor ("Rim Color", Color) = (0.35, 0.65, 1, 1)
        _RimPower ("Rim Power", Range(0.5, 8)) = 3
        _RimIntensity ("Rim Intensity", Range(0, 5)) = 1
    }
    Base "PBR"

    // 钩子：在内置 PBR 自发光计算后叠加菲涅尔边缘光
    // 可用变量：normal（世界法线）、viewDir（视线方向）、emissive（自发光，可修改）
    Hook "Emissive"
    {
        float rim = pow(1.0 - max(dot(normal, viewDir), 0.0), _RimPower);
        emissive += rim * _RimColor.rgb * _RimIntensity;
    }
}