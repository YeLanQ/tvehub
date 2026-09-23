```ts tve
import { dataCenter, Component } from "tve";

// 全局单例：跨组件共享游戏数据。写入即热，其他组件随时读取
export default class ScoreBoard extends Component {
  onStart() {
    dataCenter.set("score", 0);
  }

  onEnemyKilled() {
    // 未命中回默认值；get 返回 T | undefined（严格模式收窄后再用）
    const score = dataCenter.get<number>("score") ?? 0;
    dataCenter.set("score", score + 10);
  }

  onDestroy() {
    // 用完清理，避免悬挂数据
    dataCenter.delete("score");
  }
}

// 基本读写断言（单例本身可在任何位置直接用）
dataCenter.set("t", 1);
dataCenter.get<number>("t"); // => 1
dataCenter.has("t");         // => true
dataCenter.delete("t");      // => true
```
