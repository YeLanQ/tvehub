# SDK 总览

tve 脚本 SDK（模块说明符 `"tve"`）是编辑器脚本的唯一引擎入口。脚本以 TypeScript 编写，保存即编译，经「脚本组件」挂载到场景节点，在预览与发布产物中以相同语义运行。

当前版本：**1.3.0**（`tve.VERSION`）。

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

## 执行顺序与错误隔离

- 多组件按 `executionOrder` 升序稳定排序（检查器组件卡片可调），同序保持挂载顺序；入口脚本执行顺序为 0；
- 停机时逐实例 `onDisable` → `onDestroy`；
- 单个脚本加载/实例化/生命周期抛错只停用该实例并上报控制台，不影响其他脚本。

## 入口脚本

项目设置 → 基础信息 → 「入口脚本」可选一个 `src/**.ts`：随预览/发布运行，挂载在场景根节点（适合全局管理器）。节点级行为请在检查器挂载脚本组件。

## 属性读取

- 装饰器字段直接 `this.字段名` 读写（类型确定）；
- `this.props` 提供只读属性值视图（字段当前值 + 检查器覆盖值），便于以字典方式遍历；不要在该视图写入。

## 下一步

- [装饰器](decorators.md)：`@property` / `@nodeType`
- [实体与查询](entity.md)：`Entity`、场景/组件查找
- [engine 入口](engine.md)：时间/输入/物理/音频等系统 API
