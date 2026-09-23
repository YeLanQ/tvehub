```ts tve
import { Delegate, Component } from "tve";

// 定义（常放一个公开组件类上作全局事件总线）
export class GameEvents extends Component {
  static readonly onScore = new Delegate<(delta: number) => void>();
}

// 订阅：add 返回退订令牌（成员函数建议用令牌退订）
const token = GameEvents.onScore.add((delta) => { /* 得分处理 */ });
GameEvents.onScore.count; // => 1

// 同一函数重复订阅只登记一次（同一引用去重）
const fn = () => {};
GameEvents.onScore.add(fn);
GameEvents.onScore.add(fn);
GameEvents.onScore.count; // => 2（lambda + fn；fn 重复添加只登记一次）

// 广播：按订阅顺序逐个调用；单个回调抛错被隔离，不影响其余
GameEvents.onScore.invoke(10);

// 退订：令牌或原函数均可；onDestroy 里 clear() 防悬挂订阅
GameEvents.onScore.remove(token); // => true
GameEvents.onScore.remove(fn);    // => true
GameEvents.onScore.count;         // => 0
GameEvents.onScore.clear();
GameEvents.onScore.count;         // => 0
```
