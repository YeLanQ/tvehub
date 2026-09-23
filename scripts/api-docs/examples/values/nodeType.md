```ts tve
import { Component, nodeType, property } from "tve";

// 类装饰器：声明脚本类同时成为一种可创建节点类型（层级面板「添加节点 > 脚本节点」）
// kind = 生成的基础节点类型；label = 菜单显示名（缺省取类名）
@nodeType({ kind: "meshNode", label: "敌人" })
export default class Enemy extends Component {
  @property({ label: "生命值", min: 1 })
  hp = 100;

  @property({ label: "移动速度", min: 0 })
  speed = 2;
}
```

kind 缺省为 `"node"`（空组基础节点）：

```ts tve
import { Component, nodeType, property } from "tve";

@nodeType({ label: "旋转体" })
export default class Spin extends Component {
  @property({ min: 0 })
  speed = 90;

  onUpdate(delta: number) {
    this.entity.rotate(0, this.speed * delta, 0);
  }
}
```
