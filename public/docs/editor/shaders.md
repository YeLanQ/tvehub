# 着色器与自定义效果

本引擎的渲染分支只有三个出口：**PBR / Unlit（无光照）/ 卡通**。着色器资产（`.shader`）是自定义着色效果的唯一载体，它同时做两件事：

1. 用 `Base` 声明材质走哪个渲染分支；
2. 用 `Hook` 块在该分支的着色阶段叠加自定义效果（菲涅尔边缘光、扫描线、溶解、UV 动画、顶点位移……）。

内置的三份着色器（`PBR.shader` / `Unlit.shader` / `Toon.shader`）就是写效果的**模板**：新建着色器时选一个分支，模板里已写好 Base 与注释示例，改 Hook 即可。基础材质的光照、金属度/粗糙度、贴图、卡通分档全部保留。

## 一、创建与挂载

1. 资产面板右键 → **新建着色器** → 选渲染分支（PBR / Unlit / 卡通），生成对应模板；
2. 编辑效果：资产检查器选中它 → **编辑源码**（Monaco GLSL）→ 保存（`Ctrl+S`），保存后立即重新解析并刷新引用它的网格；
3. 材质卡片 / 材质资产的「着色器」下拉里挂载它 → 渲染分支与参数分组随之切换；
4. 也可以从首页**创意工坊 → Effect** 复制现成示例（6 个内置效果）到项目后改成自己的。

着色器的 `Properties` 参数值存在材质资产里（`.mat` 的 `props` 字段，如 `{ "_RimPower": 3, "_RimColor": 16746496 }`），随材质一起复制/导出。

## 二、源文件结构

```hlsl
Shader "assets/shaders/MyEffect"             // 指令名 = 资产路径去扩展名（保存时自动同步）
{
    Properties
    {
        _RimColor ("Rim Color", Color) = (0.35, 0.65, 1, 1)
        _RimPower ("Rim Power", Range(0.5, 8)) = 3
    }
    Base "PBR"                               // 渲染分支：PBR / Unlit / Toon

    CGINCLUDE                                // 可选：共享工具函数（inline 到各钩子之前）
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    ENDCG

    Hook "Emissive"                          // 钩子：注入到内置材质的自发光阶段
    {
        float rim = pow(1.0 - max(dot(normal, viewDir), 0.0), _RimPower);
        emissive += rim * _RimColor.rgb;
    }
}
```

| 块 | 作用 |
| --- | --- |
| `Properties` | 材质面板暴露的参数（每一项声明为 uniform，值存 `.mat` 的 `props`） |
| `Base "…"` | 渲染分支：`PBR` / `Unlit` / `Toon`（大小写不敏感，`physical` 为 PBR 别名） |
| `CGINCLUDE … ENDCG` | 共享代码（工具函数），inline 到每个钩子之前 |
| `Hook "名" { … }` | 效果片段，注入到内置着色器的对应阶段；多个钩子按声明顺序注入 |

`Base` 缺失或未知时：材质仍按默认分支（PBR）渲染，检查器会给出解析错误提示——不会渲染中断。

## 二·补、旧版着色器（缺 Base）怎么处理

上一版（重构前）的 `.shader` 是按 `#pragma` 判别分支的"渲染分支程序"，**没有 `Base` 声明**。挂到材质上时检查器会提示「未声明 Base」，此时材质仍按默认分支（PBR）渲染，只是不叠加效果。

处理方式：打开该着色器的资产检查器，点 **「补上 Base "…"」**——引擎按旧规则（`#pragma surface surf Toon` → Toon、其余 surface → PBR、仅顶点片元 pragma → Unlit）推断出原分支，只在 `Shader { … }` 块首插入一行 `Base "…"`，其余内容原样保留；保存后即可继续在该分支上写 Hook。也可以手动加这一行，或在源码编辑器里改写。

## 三、钩子（Hook）与分支支持

| 钩子 | 注入位置 | 可修改变量 | 其他可用变量 | PBR | 卡通 | Unlit |
| --- | --- | --- | --- | --- | --- | --- |
| `Vertex` | 顶点变换前（`#include <begin_vertex>` 之后） | `position`（物体空间位置） | `normal`、`uv`、`_Time` | ✓ | ✓ | ✓ |
| `Normal` | 片元法线计算后 | `normal`（世界法线） | `viewDir`、`uv` | ✓ | ✓ | ✗ |
| `Diffuse` | 漫反射颜色计算后 | `diffuseColor`（vec4） | `viewDir`、`uv`、`_Time` | ✓ | ✓ | ✓ |
| `Emissive` | 自发光计算后 | `emissive`（vec3） | `normal`、`viewDir`、`uv`、`_Time` | ✓ | ✓ | ✗ |
| `Fragment` | 最终片元输出前 | `fragColor`（= `gl_FragColor`） | `viewDir`、`uv`、`_Time` | ✓ | ✓ | ✓ |

`Unlit`（three 的 MeshBasicMaterial）没有法线/自发光阶段，因此不支持 `Normal` / `Emissive`，片元阶段也没有 `viewDir` / `normal` —— 写到这些会在保存后的解析结果里报错并指出原因（不会静默失效）。

一个着色器可以写多个 Hook（同名只取首个）。**每个 Hook 各自独立作用域**：局部变量（包括引擎注入的 `viewDir`）不会跨 Hook 冲突，也因此不共享——Hook 之间只通过端口变量（`diffuseColor` / `emissive` / `normal` / `position`）与 `CGINCLUDE` 里的工具函数协作（需要跨 Hook 复用逻辑就写成 `CGINCLUDE` 函数，或各自重算）。

## 四、Properties：暴露给材质的参数

| 写法 | 声明 | 面板控件 | `.mat` 存储 |
| --- | --- | --- | --- |
| `_Color ("文案", Color) = (1, 1, 1, 1)` | `vec4` | 取色器 | RGB hex 数字（a 恒为 1，sRGB→线性） |
| `_Power ("文案", Range(0, 8)) = 3` | `float` | 数值（带上下界） | 数字 |
| `_Amount ("文案", Float) = 0.5` | `float` | 数值（±10000） | 数字 |
| `_Count ("文案", Int) = 3` | `float` | 数值（取整） | 数字 |
| `_Dir ("文案", Vector) = (0, 1, 0, 0)` | `vec4` | 四个数值框 | `[x, y, z, w]` |
| `_MainTex ("文案", 2D) = "white" {}` | `sampler2D` | 贴图下拉（按 sRGB 加载） | 资产相对路径（空串 = 无贴图） |

## 五、内置 uniform

无需声明，直接使用：`_Time`（运行秒数：编辑器 = 引擎运行时长，产物 = 播放开始后的时长），以及 three 的标准量（`modelMatrix` / `modelViewMatrix` / `projectionMatrix` / `viewMatrix` / `normalMatrix` / `cameraPosition`）。

## 六、与材质参数的分工

- 基础外观（基础色、金属度/粗糙度、贴图、卡通明暗、轮廓、不透明度）在材质卡片上按分支参数调，不用改着色器；
- 着色器只负责"内置分支表达不了的效果"，自定义参数通过 `Properties` 暴露；
- 换分支（PBR → Unlit/卡通）只需换材质挂载的着色器（或改它的 Base 后重新保存）。

## 七、报错与回退

- **解析错误**（未知钩子名 / Unlit 上用了不支持的钩子 / 缺 Base）：保存仍成功，资产检查器与材质卡片显示原因，材质**仍按 Base 分支渲染**，只是不叠加效果；
- **GLSL 编译失败**（语法错误、未声明变量）：编辑器控制台输出编译日志摘要，视口不渲染该网格；
- **着色器文件被删除**：材质回退默认分支（下拉显示「（缺失）」），不会中断渲染。

## 八、WebGPU 后端（同一契约翻译为 TSL）

WebGPU 后端下材质改用 three 的节点材质（MeshPhysical/Basic/Toon NodeMaterial），同一份 Hook 片段由 **GLSL→TSL 转译**接到对应端口槽位，`.shader` 不用改：

| 端口（勾子） | WebGL 实现 | WebGPU 实现 |
| --- | --- | --- |
| Vertex | 注入 `#include <begin_vertex>` 后，写 `transformed` | `positionNode`（种子 = `positionLocal`） |
| Diffuse | 注入 `#include <color_fragment>` 后，写 `diffuseColor` | `colorNode` + `opacityNode`（种子 = 基色×贴图 / 不透明度） |
| Emissive | 注入 `#include <emissivemap_fragment>` 后，写 `totalEmissiveRadiance` | `emissiveNode`（种子 = 自发光×强度×贴图） |
| Normal | 注入 `#include <normal_fragment_maps>` 后，写 `normal` | `normalNode`（种子 = 视空间法线） |
| Fragment | 注入 `#include <dithering_fragment>` 前，写 `gl_FragColor` | **不支持**（节点材质下最终颜色由引擎内部合成，无法作为"当前值"喂给 Hook） |

- 只读变量同名同义：`normal`（视空间法线；Vertex 端口下为物体空间）、`viewDir`（视空间视线）、`uv`、`_Time`；`Properties` 同规则映射为 TSL uniform，`.mat` 的 `props` 照旧生效；
- 翻译取的是**受控子集**（与编辑器内置转译器一致：局部变量、赋值、if/else、discard、常见内置函数、CGINCLUDE 工具函数 inline）。子集之外的写法（循环、数组、结构体、矩阵下标等）会让**该 Hook 不生效**，编辑器/播放器控制台会给出"转译为 TSL 失败"的原因，材质仍按 Base 分支渲染；
- 因此**跨后端可移植的效果建议只用受控子集**；Fragment 端口只在 WebGL 下生效（需要跨后端就改用 Diffuse/Emissive 端口表达）。

## 八·补：渲染后端差异汇总

| 能力 | WebGL | WebGPU |
| --- | --- | --- |
| 分支配方参数（金属度/卡通/贴图…） | ✓ | ✓（节点材质自带同名属性） |
| Vertex / Diffuse / Emissive / Normal 端口 | ✓ | ✓（翻译为 TSL） |
| Fragment 端口 | ✓ | ✗（显式告警） |
| 受控子集外的 GLSL 写法 | 直接编译，可能通过 | 该 Hook 不生效（告警） |

## 九、天空程序（内置资产）

`internal/shaders/SkyProcedural.shader` / `SkyBox.shader` 是天空程序，由天空材质引用（按 `Tags` 里的 `"PreviewType"="Skybox"` 标记识别），**不参与效果着色器管线**（没有 Hook，也不出现在材质卡片的着色器下拉里）。

## 十、与构建导出的关系

导出产物内的网页运行时（`engine/runtime/shader.mjs` 解析 + `engine/runtime/shaderHooks.mjs` 注入）按**同一套规则**处理同一份 `.shader`：Base → 渲染分支、钩子注入位置与变量映射、属性表、`_Time` 推进在编辑器与产物中行为一致；`.mat` 的 `shader` 引用与 `props` 里的贴图引用都会随构建打包（发布模式下随资产重命名一并改写）。
