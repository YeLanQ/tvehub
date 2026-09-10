# 自定义着色器

自定义着色器（`.shader` 种类 = **自定义着色器**，kind `custom`）把源码真正编译成 GLSL 程序渲染网格，用来实现内置分支（PBR / Unlit / 卡通）覆盖不了的效果：菲涅尔边缘光、扫描线、溶解、UV 动画、顶点位移、自定义光照模型、双面半透明等。

与内置分支的区别：内置分支源码**不被编译**，只按 `#pragma` 映射到 three 现成材质（类型在创建时固定）；自定义着色器源码**会被编译**，改源码即改渲染效果，并支持保存后即时热更新（编辑器视口与网页预览/构建产物同款渲染）。

## 创建与编辑

1. 资产面板右键（或空白处右键）→ **新建着色器 → 自定义着色器**（基名 `Custom`），生成可渲染的起步模板；
2. 资产检查器中选中它 → **编辑源码** → Monaco 编辑器（GLSL 着色）→ **保存**（`Ctrl+S`）；
3. 材质卡片 / 材质资产的「着色器」下拉里挂载它 → 参数分组自动切换为着色器暴露的 `Properties`。

内置目录提供 `internal/shaders/Custom.shader` 示例（菲涅尔边缘光 + `_Time` 呼吸脉冲），可「复制到项目」后改写成自己的效果。自定义着色器的材质参数值存在 `.mat` 的 `props` 字段里（`{ "_Color": 16711808, "_Speed": 2.5 }`），随材质资产一起复制/导出。

## 源文件结构

```hlsl
Shader "assets/shaders/MyEffect"      // 指令名 = 资产路径去扩展名（保存时自动同步）
{
    Properties
    {
        _Color ("Base Color", Color) = (1, 1, 1, 1)
        _Speed ("Pulse Speed", Range(0, 4)) = 1
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" }

        CGINCLUDE                      // 共享代码：两个阶段都会拼入
        varying vec2 vUv;
        ENDCG

        CGPROGRAM                      // 顶点块
        #pragma vertex vert
        void vert()
        {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
        ENDCG

        CGPROGRAM                      // 片元块
        #pragma fragment frag
        vec4 frag()
        {
            return texture2D(_MainTex, vUv) * _Color;
        }
        ENDCG
    }
}
```

识别规则：源文件含 `CGINCLUDE` 块**或**至少两个 `CGPROGRAM` 块 → 判为自定义着色器（内置分支模板是单块顶点片元 / `#pragma surface`，不会误判）。

### 三个代码块

| 块 | 作用 |
| --- | --- |
| `CGINCLUDE … ENDCG` | 共享声明（`varying`、工具函数）。会拼进顶点与片元两个着色器，**不要在其中使用阶段专属内置变量**（如 `gl_Position`、顶点属性 `position`） |
| `CGPROGRAM … ENDCG` + `#pragma vertex` | 顶点阶段：在入口函数里写 `gl_Position`（默认入口名 `vert`，可由 pragma 指定） |
| `CGPROGRAM … ENDCG` + `#pragma fragment` | 片元阶段：入口函数返回 `vec4`（默认入口名 `frag`，返回 `void` 时自行写 `gl_FragColor`） |

入口函数由引擎包装成 `main()`；若块内自己定义了 `void main()`，引擎不再包装（高级用法）。

## Properties：暴露给材质的参数

`Properties` 每一项会被**自动声明为 uniform**（值来自材质面板，写入 `.mat` 的 `props`），源码里**不要重复声明**；若确实手工声明了（`uniform vec4 _Color;`），引擎会跳过自动声明。

| 写法 | 自动声明 | 面板控件 | `.mat` 存储 |
| --- | --- | --- | --- |
| `_Color ("文案", Color) = (1, 1, 1, 1)` | `uniform vec4` | 取色器 | RGB hex 数字（a 恒为 1） |
| `_Speed ("文案", Range(0, 4)) = 1` | `uniform float` | 数值（带上下界） | 数字 |
| `_Amount ("文案", Float) = 0.5` | `uniform float` | 数值（±10000） | 数字 |
| `_Count ("文案", Int) = 3` | `uniform float` | 数值（取整） | 数字 |
| `_Dir ("文案", Vector) = (0, 1, 0, 0)` | `uniform vec4` | 四个数值框 | `[x, y, z, w]` |
| `_MainTex ("文案", 2D) = "white" {}` | `uniform sampler2D` | 贴图下拉（按 sRGB 加载） | 资产相对路径（空串 = 无贴图） |

自动声明是**按阶段**进行的：某个 uniform 只在片元块被引用，就只声明在片元着色器里（避免顶点阶段白白占用采样器单元）。未被引用的属性只是面板上多个控件，不影响编译。

## 内置 uniform 与变量

无需声明，直接使用：

| 名称 | 含义 |
| --- | --- |
| `_Time` | 运行秒数（编辑器为引擎运行时长，网页产物为播放开始后的时长），做循环动画用 |
| `modelMatrix` / `modelViewMatrix` / `projectionMatrix` / `viewMatrix` / `normalMatrix` | 标准变换矩阵 |
| `cameraPosition` | 相机世界坐标（两阶段都可用） |
| `position` / `normal` / `uv` | 顶点属性（顶点阶段；`uv` 在片元阶段通过 `varying` 传递） |

示例：菲涅尔边缘光的片元代码（`vNormalW`/`vViewDirW`/`vUv` 由 `CGINCLUDE` 声明、顶点块写入）：

```glsl
float fres = pow(1.0 - max(dot(normalize(vNormalW), normalize(vViewDirW)), 0.0), 3.0);
float pulse = 0.75 + 0.25 * sin(_Time * _Speed * 6.2831853);
return vec4(c.rgb * pulse + _RimColor.rgb * _RimColor.a * fres, c.a);
```

## 输出阶段（颜色与亮度）

引擎在包装入口函数时补上 three 的输出阶段（`#include <tonemapping_fragment>` + `#include <colorspace_fragment>`），
自定义着色器因而与内置材质共用同一套颜色管线：面板取的色（sRGB）自动转线性使用、按项目设置做色调映射（HDR 工程的
ACES 同样生效）、再转回输出色彩空间——同一个 `#ff8800` 在 PBR 材质与自定义着色器里看起来一致。

入口函数返回的颜色是**线性空间**的值。若自己写 `void main()`（不走入口包装），输出阶段需自行处理
（可自行加 `#include <colorspace_fragment>`）。

## 渲染状态（可选）

缺省 = 不透明、写深度、剔除背面。需要半透明/双面/叠加效果时在 `SubShader` 内声明（标签或指令行两种写法都接受）：

| 声明 | 效果 |
| --- | --- |
| `Tags { "Queue"="Transparent" }` 或 `"RenderType"="Transparent"` | 半透明混合（片元返回的 alpha 参与混合） |
| `Tags { "ZWrite"="Off" }` 或 `ZWrite Off` | 关闭深度写入（半透明、叠加、描边常用） |
| `Tags { "Cull"="Off" }` 或 `Cull Off` | 双面渲染 |
| `Cull Front` / `Cull Back` | 只渲染背面 / 只渲染正面（缺省） |

## 报错与回退

- **组装失败**（缺顶点/片元块、找不到入口函数）：保存仍会成功，检查器与材质卡片显示原因，视口回退**洋红棋盘占位材质**，方便一眼定位；
- **GLSL 编译失败**（语法错误、未声明变量）：编辑器控制台输出编译日志摘要（含拼接后的行号偏移提示），视口不渲染该网格；
- 着色器文件被删除 / 引用丢失：材质回退占位材质，检查器的着色器下拉显示「（缺失）」。

## 与构建导出的关系

导出产物内的网页运行时（`engine/runtime/shaderlab.mjs`）按**同一套规则**解析同一份 `.shader` 源码：属性表、程序组装、渲染状态、`_Time` 推进在编辑器与产物中行为一致；`.mat` 的 `props` 贴图引用会随构建打包（发布模式下随资产重命名一并改写）。
