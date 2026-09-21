# 单元：场景查询与跨组件通信（find/tag/DataCenter/Delegate）

## 契约（速查）

`engine.scene: SceneApi`：`root`、`find(nameOrPath)`（名称或 "父/子" 路径，未找到
null）、`findAll()`、`findByTag(tag)`（首个命中）、`findAllByTag(tag)`（全量）、
`findComponent(token)` / `findComponents(token)`（全场景按组件类型查；token = 脚本类/
源路径/类名/内置门面类）。
`Entity.find("路径")` 子树内查找；`getComponent` 传脚本类或 `"src/hp.ts"`/"HPBar"
字符串；脚本类加载后全局可见，**互相引用组件无需 import 运行时值**
（严格模式用 `import type` 拿智能提示）。
共享状态：`dataCenter`（全局单例）`set/get<T>(key, def)/has/delete/keys/configure/
stats`——写即热、闲置自动降冷为冻结快照、读冷数据自动回温；含函数对象降冷按
克隆兜底。事件广播：`new Delegate<T>()`：`add(fn) → token`、`remove(token|fn)`、
`invoke(...args)`（快照迭代、单回调抛错隔离）、`clear()`（onDestroy 防悬挂）。

## 模板：跨组件通信（Delegate 广播 + DataCenter 计分）

```ts
import { Component, property, engine, Delegate, dataCenter } from "tve";

/** 全局事件总线：静态 Delegate 挂在任意一个组件类上，双方按类访问 */
export class GameEvents extends Component {
  static readonly onScore = new Delegate<(delta: number) => void>();
  static readonly onGameOver = new Delegate<() => void>();
}

/** 得分面板（订阅方） */
export default class ScoreBoard extends Component {
  private score = 0;
  private token: import("tve").DelegateToken | null = null;

  onEnable() {
    this.token = GameEvents.onScore.add((d) => this.add(d));   // add 返回退订令牌
  }
  onDisable() {
    if (this.token) GameEvents.onScore.remove(this.token);
  }
  private add(delta: number) {
    this.score += delta;
    dataCenter.set("score", this.score);       // 其他脚本 dataCenter.get<number>("score", 0)
  }
}
```

要点：`add` 返回令牌，`onDisable` 里凭令牌退订（成员函数建议用令牌而非原函数）。

## 模板：按类型找组件 / 节点引用解耦

```ts
import { Component, engine, math } from "tve";
import type CameraFollow from "./CameraFollow";      // type-only：编译期擦除

export default class Enemy extends Component {
  follow!: CameraFollow;                    // 字段类型 = 脚本类 → 宿主自动绑定/创建

  onStart() {
    // ① 组件字段自动 get-or-create（推荐）
    this.follow?.offset = math.v3(0, 3, 5);
    // ② 手动按类名/路径找（脚本组件全局可见，无需 import 运行时值）
    const hp = this.entity.getComponent("HPBar");
    // ③ 全场景按组件类型查（文档序首个/全量）
    const first = engine.scene.findComponent("HPBar");
    const all = engine.scene.findComponents("HPBar");
    // ④ 标签批量：检查器 Node 卡设 tag → findAllByTag("enemy")
    for (const e of engine.scene.findAllByTag("enemy")) e.visible = false;
  }
}
```

## 模板：节点类型引用的收窄

```ts
import { LightNode, Light } from "tve";
// 灯光属性走组件门面 Light；LightNode 是节点句柄不能传给 getComponent
const light = this.entity.getComponent(Light);            // ✅
// 引用别的灯光节点：@property({ type: LightNode }) 后字段即 LightNode 实例
// 或 engine.scene.find("主灯") 后 instanceof LightNode 收窄
```

## 测试例

- 工坊示例：`CameraFollow.ts`（节点引用 + math）、`VirtualJoystick.ts`
  （DataCenter 跨脚本传摇杆状态）、`LookAtTarget.ts`。
- 通信/查询是纯运行时语义，回归挂在 `smoke-script-hooks.mjs` 与
  `smoke-graph-runtime.mjs`（graph 接入 onGraphInput 的实体集通道）。
