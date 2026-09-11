// @desc: 溶解消失：在 PBR 基础上叠加噪声阈值裁剪 + 边缘发光（效果着色器 · PBR 分支）
// TVE 效果着色器示例：复制到项目 assets/shaders/ 后，在材质卡片的「着色器」下拉里挂载。
// Base 声明本资产用的渲染分支（此处 PBR），Hook 块是叠加在其上的效果片段——
// PBR 光照保留，效果只是叠加/裁剪片元。
// 玩法：把 _Threshold 从 0 调到 1 会让物体按噪声图案逐渐消失；边缘（阈值附近）发光。
Shader "effect/DissolveExt"
{
    Properties
    {
        _Threshold ("Dissolve Amount", Range(0, 1)) = 0.35
        _NoiseScale ("Noise Scale", Range(0.5, 40)) = 8
        _EdgeColor ("Edge Color", Color) = (1, 0.55, 0.1, 1)
        _EdgeWidth ("Edge Width", Range(0.001, 0.3)) = 0.06
        _EdgeIntensity ("Edge Intensity", Range(0, 8)) = 3
    }
    Base "PBR"

    CGINCLUDE
    // 值噪声（GLSL ES 兼容：无位运算、无 textureLod）
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

    // 钩子：在漫反射颜色计算后按噪声裁剪片元
    // 可用变量：uv（纹理坐标）、diffuseColor（漫反射颜色，可修改）
    Hook "Diffuse"
    {
        float n = noise(uv * _NoiseScale);
        if (n < _Threshold) discard;
    }

    // 钩子：在自发光计算后叠加溶解边缘发光
    // 可用变量：uv、emissive（自发光，可修改）
    Hook "Emissive"
    {
        float n = noise(uv * _NoiseScale);
        float edge = 1.0 - smoothstep(_Threshold, _Threshold + _EdgeWidth, n);
        emissive += _EdgeColor.rgb * edge * _EdgeIntensity;
    }
}