# 测试过程中发现的问题清单

本轮补测试（2026-09-21，kp-3）期间发现并处理的问题。分三档：
**已修复**（随本轮改动落地，含验证方式）、**契约漂移**（产品行为已变、
断言未跟上，需要产品决策后改测试或改代码）、**低风险怪癖**（行为可解释、
影响小，记录备查）。

## 已修复（产品代码 bug）

### 1. 平行光阴影相机投影基用错坐标系 —— 滚转灯光裁掉场景角落
- **位置**：`src/framework/engine/modules/SceneSynchronizer.ts` `fitShadowCamera`
- **现象**：smoke `shadow` 套件「整场景包围盒 8 角点全部落在阴影视锥内」失败
  （8a46888 紧凑贴合改造引入）。正交范围按**灯自身矩阵**的 X/Y 轴投影包围盒
  角点，但 three 的阴影相机姿态是 `lookAt(灯位→目标, up=Y)`——灯自身带滚转时
  两套轴不一致，视锥裁掉场景角落、边缘阴影丢失。
- **修复**：投影基改为 `Matrix4.lookAt(灯位, 目标, (0,1,0))`，与渲染时 three
  为阴影相机选的姿态逐位一致。
- **风险**：低——只改投影基，near/far 与后推逻辑不变；`smoke shadow` 48 项全绿。

### 2. ScenePrototype.fromJSON 丢失全部子孙节点
- **位置**：`src/framework/scene/ScenePrototype.ts`
- **现象**：`fromJSON` 只登记根节点，嵌套 `children` 文档整体丢弃（序列化写嵌套
  children、反序列化只认 childIds），往返后 `getNodeCount()` 从 3 变 1。
- **修复**：按「嵌套 children 为层级事实源」约定（与 .prefab / 后端
  Graph::from_root_doc 一致）递归 ingest，重建 childIds 与 childrenIndex。
- **风险**：低——应用层当前只用该模块的 `createDefaultMetadata/Settings` 工厂，
  fromJSON/clone 无业务调用方；属导出 API 的正确性修复。

### 3. ScenePrototype.clone 把克隆子孙挂进源场景
- **位置**：同上 `cloneNode`（`this.nodes.set` 的 `this` 指向源场景）
- **现象**：克隆产物只剩根节点，且源场景的 nodes map 被塞入克隆节点（污染）。
- **修复**：重写为 `cloneNodeInto(target, …)`，全部状态落在目标场景上。

### 4. GLSL 词法器丢弃 `3f` 浮点后缀字面量
- **位置**：`src/framework/material/tsl/glslLexer.ts`
- **现象**：`Number("3f")` = NaN，带 f 后缀的 GLSL 浮点字面量被静默剔除并记
  error，导致后续 token 流错位（合法 GLSL 写法）。
- **修复**：转数值前剥掉尾部 `f/F`。

## 已修复（测试侧缺陷）

### 5. smoke 假 canvas 缺 `style` 桩，两个套件整体崩溃
- `input-runtime` / `physics-pick` 在 `canvas.style.touchAction` 处 TypeError，
  崩溃点之后的所有断言被掩埋（真实浏览器 canvas 恒有 style）。补 `style: {}`
  桩后两套件 60 项断言全部通过。**教训**：套件崩溃（断言数未知）比断言失败
  更值得警惕——它把后续覆盖面整个藏起来了。

### 6. smoke-shadow 断言的对称假设
- 视锥覆盖检查用 `Math.abs(v.x) > cam.right`，但紧凑贴合产出的是**非对称**
  left/right（本例 L≈-29.7 / R≈13.1）——角落实际在视锥内却判失败。改为按
  left/right/top/bottom 四边界分别判。

### 7. smoke-shadow-runtime 的 2048 过期期望
- 平面光自动档贴图已从 2048 提到 4096（源码注释说明了动机：齐平/掠射光下
  影子被拉长，2048 纹素盖不住），运行时镜像同步为 4096，套件期望没跟上。

### 8. smoke-workshop-import 的 {{CLASS_NAME}} 过期期望
- 14b2839 起「工坊脚本原样落盘（仓库即所得）」，真实工坊文件自带真实类名、
  不再含占位符；套件仍按旧「注入类名」契约断言。已按新行为重写。

## 契约漂移（未修，需产品决策）——P1 套件的既有失败

> 共 3 套件 10 断言失败（particles 5 + particles-runtime 1 + terrain 4），
> 均为「断言的 API/菜单已不存在」。已从 P0 核心集剔除，发版前跑全量时过目。

### 9. terrain：运行时导出面与断言不符（4 处）
- `tve.mjs 再导出 TerrainNode/terrainNode`、`runtime/terrain.mjs 提供
  createTerrain / createTerrains 采样 API`、`资产菜单含「新建地形」`——产物
  里的导出名/菜单位置与断言的检索方式对不上（重建 public/engine 后依旧，
  排除产物过期）。需要确认：SDK 导出面以什么为准、菜单文案挂在哪个组件。

### 10. particles / particles-runtime：渲染后端与材质工厂契约（6 处）
- 「舞台层按项目设置选择渲染后端并回报 backend」「WebGPU 动态加载失败回退
  WebGL」「运行时导出 GLSL 材质工厂并支持注入」等——渲染后端选择链路重构后
  契约变了，断言未跟上。涉及 WebGPU/WebGL 双后端选型策略，建议由渲染链路
  负责人定契约后一次性更新。

## 低风险怪癖（备查）

### 11. stampSplatLine 零长线段盖两章
- `steps = max(1, ceil(0/step))` 后循环 `i <= steps` 从 0 到 1——单击（零长
  拖拽）实际盖两章，比单章 `stampSplat` 收敛快一倍。权重模型单调收敛，无双
  侧副作用，仅强度手感略重；如需「单击 = 单章」改循环起点即可。

### 12. vitest 5 阈值分组形式
- vitest 5.0.1 的 `coverage.thresholds` 只认 **glob 键对象**（每键一桶）；
  常见的数组分组写法（`{name, includes}`）会被静默忽略（数组展开后键是
  "0"/"1"，匹配不到任何文件，全局阈值又取不到标量字段 → 不结算、不报错）。
  已用 glob 键形式并做负向验证（故意设 100 确认会拦）。

### 13. 工坊重名导入会留下同名类
- 14b2839 的「原样落盘」取舍下，同名导入 "Rotator 2.ts" 的类名仍是 Rotator
  ——两个文件声明同名类，场景里 `script:<类名>` 的指向存在歧义可能。旧设计
  （类名跟文件名）被有意移除，此风险随取舍回归；如出现脚本绑定歧义再评估
  是否恢复类名同步或加导入提示。
