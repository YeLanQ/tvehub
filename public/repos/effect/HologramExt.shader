// @desc: 全息投影：菲涅尔边缘发光 + 横向扫描线（效果着色器 · PBR 分支）
// TVE 效果着色器示例：复制到项目 assets/shaders/ 后，在材质卡片的「着色器」下拉里挂载。
// Base 声明本资产用的渲染分支（此处 PBR），Hook 块是叠加在其上的效果片段——
// 光照/金属度/粗糙度全部保留，效果只是叠加在自发光上。
// 全息观感另需在材质卡片调「不透明度」< 1（半透明混合），并在需要时关/开线框；
// 玩法：调 _RimPower（边缘锐度）、_ScanDensity（扫描线密度）、_ScanSpeed（流动速度）即可。
Shader "effect/HologramExt"
{
    Properties
    {
        _Color ("Hologram Color", Color) = (0.35, 0.85, 1, 1)
        _RimColor ("Rim Color", Color) = (0.6, 0.95, 1, 1)
        _RimPower ("Rim Power", Range(0.5, 8)) = 2.5
        _ScanDensity ("Scan Line Density", Range(1, 60)) = 16
        _ScanSpeed ("Scan Speed", Range(-4, 4)) = 0.6
        _ScanStrength ("Scan Strength", Range(0, 1)) = 0.35
    }
    Base "PBR"

    // 钩子：在自发光计算后叠加菲涅尔边缘光 + 横向扫描线
    // 可用变量：normal（世界法线）、viewDir（视线方向）、uv、_Time（运行秒数）、
    //           emissive（自发光，可修改）
    Hook "Emissive"
    {
        // 菲涅尔：视线越掠过表面（边缘）越亮
        float rim = pow(1.0 - max(dot(normal, viewDir), 0.0), _RimPower);
        // 横向扫描线：沿 UV.y 移动的条纹，_Time 让条纹随运行时间流动
        float scan = sin((uv.y + _Time * _ScanSpeed) * _ScanDensity * 6.2831853);
        scan = scan * 0.5 + 0.5;
        emissive += (_Color.rgb + _RimColor.rgb * rim) * (0.25 + scan * _ScanStrength);
    }
}
