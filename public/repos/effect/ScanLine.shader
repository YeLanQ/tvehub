// @desc: 扫描线：在 PBR 基础上叠加沿 UV.y 移动的横向扫描线（效果着色器 · PBR 分支）
// TVE 效果着色器示例：复制到项目 assets/shaders/ 后，在材质卡片的「着色器」下拉里挂载。
// 演示 _Time uniform 的使用：扫描线随时间移动（需引擎渲染循环推进 _Time）。
// 玩法：调 _ScanDensity（条纹密度）、_ScanSpeed（流动速度）、_ScanStrength（强度）即可。
Shader "effect/ScanLine"
{
    Properties
    {
        _ScanColor ("Scan Color", Color) = (0.2, 0.8, 1, 1)
        _ScanDensity ("Scan Density", Range(1, 60)) = 16
        _ScanSpeed ("Scan Speed", Range(-4, 4)) = 0.6
        _ScanStrength ("Scan Strength", Range(0, 2)) = 0.5
    }
    Base "PBR"

    // 钩子：在自发光计算后叠加扫描线
    // 可用变量：uv、_Time（运行秒数）、emissive（自发光，可修改）
    Hook "Emissive"
    {
        float scan = sin((uv.y + _Time * _ScanSpeed) * _ScanDensity * 6.2831853);
        scan = scan * 0.5 + 0.5;
        emissive += _ScanColor.rgb * scan * _ScanStrength;
    }
}