# SDK 总览

tve 脚本 SDK（模块说明符 `"tve"`）是编辑器脚本的唯一引擎入口。脚本以 TypeScript 编写，保存即编译，经「脚本组件」挂载到场景节点，在预览与发布产物中以相同语义运行。

当前版本：**1.3.0**（`tve.VERSION`）。

## 设计约束

- **全部为引擎自有类型**（`Vec3` 普通对象、度制欧拉角、0xRRGGBB 颜色整数），与编辑器数据模型一致——不暴露任何 three.js / WebGL 接口；
- **编辑器与运行时同一套语义**：在编辑器里摆的姿势、单位、朝向约定，到预览/发布产物中原样生效；
- 类型契约在编辑器内 `src/framework/scripting/tve.d.ts`（Monaco 智能提示直接可用），运行时实现与之镜像同步。

## 快速上手

1. 在资产面板 `src/` 目录右键「新建脚本」，或经检查器「添加组件 > 脚本」创建；
2. 双击 `.ts` 资产进入脚本工作台编写；
3. 默认导出一个继承 `Component` 的类，用 `@property` 声明可编辑属性；
4. 在节点检查器「添加组件 > 脚本」挂载，检查器中即可配置属性；
5. 工具栏切到「预览」或按播放运行，脚本进入生命周期。

```ts
import { Component, property, engine } from "tve";

export default class Spin extends Component {
  @property({ label: "速度", min: 0 })
  speed = 90;

  onStart() {
    engine.log("挂载于", this.entity.name);
  }

  onUpdate(delta: number) {
    this.entity.rotate(0, this.speed * delta, 0);
  }
}
```

## 组件生命周期

全部钩子可选、按需实现：

| 钩子 | 时机 |
| --- | --- |
| `onEnable()` | 实例创建后调用；**全部实例的 onEnable 先于全部 onStart**，此时可安全引用其他实体与组件 |
| `onStart()` | 全部脚本实例创建后、首个 `onUpdate` 前调用一次（初始化玩法逻辑） |
| `onUpdate(delta)` | 每帧调用，`delta` 为距上一帧的秒数 |
| `onCollisionEnter(other)` | 本节点碰撞体与对方碰撞体开始接触；**在 onUpdate 前调用**；传感器同样触发 |
| `onCollisionExit(other)` | 接触断开；`other` 为对方 `Entity` |
| `onDisable()` | 页面卸载/预览停机时调用一次（先于 onDestroy），用于释放定时器/事件订阅 |
| `onDestroy()` | 实例销毁时调用 |

物理回调前提：本节点挂有「碰撞体」组件，且项目设置启用物理（编辑器视口内手动模拟同样分发）。

### 实例化顺序详解

场景启动时（预览进入/产物加载）：

1. 按场景**文档序**（层级树深度优先，与层级面板从上到下一致）收集全部脚本组件；
2. 逐个加载模块并实例化（模块顶层代码此时执行）；
3. **入口脚本**（项目设置指定）最后实例化，挂载在场景根节点；
4. 全部实例按 `executionOrder` **升序稳定排序**（同序保持挂载顺序）；
5. 先对**全部实例**统一调用 `onEnable`，再统一调用 `onStart`——因此任何 `onEnable`/`onStart` 里都可以安全 `engine.scene.find` / `getComponent` 到别的脚本实例。

动态创建的脚本组件（`entity.addComponent(...)` / 组件字段自动挂载）在创建时**立即**走 `onEnable` → `onStart`（统一批次已过），并进入每帧队列（排在场景既有组件之后）。

### 每帧调度顺序

播放器主循环每帧固定次序（理解它可避免「为什么我先动了再被覆盖」类问题）：

```
碰撞回调分发（上一帧物理步进收集的接触对 → onCollisionEnter/Exit）
  → engine.time 推进 + 补间动画 tween 推进
  → 各脚本 onUpdate（按 executionOrder）
  → 骨骼动画 mixer → IK 求解 → 骨骼绑定跟随 → 动画图评估
  → 物理步进（固定 1/60s）
  → 关键帧动画 .anim → 音频 → 粒子
  → 相机位姿回填 → UI 布局解析 → 渲染
```

要点：tween 在 `onUpdate` **前**推进（本帧读到的已是补间后的值）；物理步进在脚本之后（本帧 `applyForce` 下一帧生效；`onCollisionEnter` 收到的是上一帧的接触）；动画系统晚于脚本（脚本写骨骼会被动画覆写，见[内置组件门面](components.md)）。

### 执行顺序与错误隔离

- 多组件按 `executionOrder` 升序稳定排序（检查器组件卡片可调），同序保持挂载顺序；入口脚本执行顺序为 0；动态创建的组件排末尾；
- 停机时逐实例 `onDisable` → `onDestroy`（各一次）；
- **错误隔离**：单个脚本的加载失败 / 默认导出不是 `Component` 子类 / 实例化异常 / 生命周期或 `onUpdate` 抛错，都只停用**该实例**并上报控制台（同一路径的加载失败只报一次），不影响其他脚本与渲染。生命周期抛错的实例被永久停用（不再进入每帧队列）。

## 属性读取

- 装饰器字段直接 `this.字段名` 读写（类型确定）；
- `this.props` 提供只读属性值视图（字段当前值 + 检查器覆盖值），便于以字典方式遍历；不要在该视图写入。

## 入口脚本

项目设置 → 基础信息 → 「入口脚本」可选一个 `src/**.ts`：随预览/发布运行，挂载在场景根节点（适合全局管理器）。节点级行为请在检查器挂载脚本组件。

```ts
// src/Game.ts —— 入口脚本示例：全局管理器 + 事件总线
import { Component, Delegate } from "tve";

export default class Game extends Component {
  static readonly onScore = new Delegate<(delta: number) => void>();
  private score = 0;

  onUpdate() {
    // 全局调度逻辑……
  }
}
```

## 常用约定速查

| 约定 | 值 |
| --- | --- |
| 坐标系 | 右手系，Y 向上，前向 = **-Z** |
| 位置/缩放 | 米 |
| 旋转 | 度制欧拉角 XYZ（`entity.rotation`、`entity.rotate`、动画通道同制） |
| 颜色 | 0xRRGGBB 整数（UI/灯光/粒子）；`@property` 颜色属性为 `#rrggbb` 字符串 |
| UI 单位 | 100 设计像素 = 1 UI 单位，画布原点在屏幕中心，y 向上 |
| 运行态写入 | 预览/产物内的 Entity/门面写入即时生效、**不回写场景文件** |

## 下一步

- [装饰器](decorators.md)：`@property` / `@nodeType`
- [实体与查询](entity.md)：`Entity`、场景/组件查找
- [engine 入口](engine.md)：时间/输入/物理/音频等系统 API
- [内置组件门面](components.md)：刚体/灯光/音源/骨骼动画
- [补间动画](tween.md) / [数学库](math.md) / [通用设施](utils.md)
