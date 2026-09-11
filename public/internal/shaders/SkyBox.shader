// TVE 天空程序（内置资产；由天空材质引用，无效果着色器入口）
// 天空程序：PreviewType=Skybox 标签 + samplerCUBE 采样标记立方体贴图天空盒
// （贴图引用与渲染参数存于材质 .mat 的 cubeMap/rotation/strength/blur 字段）。
Shader "internal/shaders/SkyBox"
{
    Properties
    {
        _CubeMap ("Cubemap (HDR)", CUBE) = "" {}
        _Rotation ("Rotation", Range(0, 360)) = 0
        _Strength ("Strength", Range(0, 16)) = 1
        _Blur ("Blur", Range(0, 1)) = 0
    }
    SubShader
    {
        Tags { "Queue"="Background" "RenderType"="Background" "PreviewType"="Skybox" }
        Cull Off ZWrite Off

        CGPROGRAM
        // 立方体贴图天空：视线方向绕世界 Y 轴旋转后采样 CUBE（mip 级别近似模糊）
        #pragma vertex vert
        #pragma fragment frag
        #pragma target 3.0

        #include "UnityCG.cginc"

        samplerCUBE _CubeMap;
        half _Rotation;
        half _Strength;
        half _Blur;

        struct appdata
        {
            float4 vertex : POSITION;
        };

        struct v2f
        {
            float4 pos : SV_POSITION;
            float3 dir : TEXCOORD0;
        };

        v2f vert (appdata v)
        {
            v2f o;
            o.pos = UnityObjectToClipPos(v.vertex);
            float3 w = mul((float3x3)unity_ObjectToWorld, v.vertex.xyz);
            o.dir = normalize(w - _WorldSpaceCameraPos);
            return o;
        }

        fixed4 frag (v2f i) : SV_Target
        {
            float3 dir = normalize(i.dir);
            half rad = radians(_Rotation);
            float3 rotated = float3(
                cos(rad) * dir.x + sin(rad) * dir.z,
                dir.y,
                -sin(rad) * dir.x + cos(rad) * dir.z);
            half mip = _Blur * 8.0;
            return fixed4(texCUBElod(_CubeMap, float4(rotated, mip)).rgb * _Strength, 1);
        }
        ENDCG
    }
    FallBack Off
}
