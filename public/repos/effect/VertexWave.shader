// @desc: 顶点波动：在 PBR 基础上沿法线方向做正弦波动（效果着色器 · PBR 分支）
// TVE 效果着色器示例：复制到项目 assets/shaders/ 后，在材质卡片的「着色器」下拉里挂载。
// 演示 Vertex 钩子：修改顶点位置（几何波动），PBR 光照按变形后法线计算。
// 玩法：调 _WaveAmplitude（波动幅度）、_WaveFrequency（空间频率）、_WaveSpeed（时间速度）即可。
Shader "effect/VertexWave"
{
    Properties
    {
        _WaveAmplitude ("Amplitude", Range(0, 1)) = 0.1
        _WaveFrequency ("Frequency", Range(0, 10)) = 2
        _WaveSpeed ("Speed", Range(0, 4)) = 1
    }
    Base "PBR"

    // 钩子：在顶点变换前修改位置（沿法线方向正弦波动）
    // 可用变量：position（物体空间位置，可修改）、normal（物体空间法线）、uv、_Time
    Hook "Vertex"
    {
        float wave = sin(position.y * _WaveFrequency + _Time * _WaveSpeed);
        position += normal * wave * _WaveAmplitude;
    }
}