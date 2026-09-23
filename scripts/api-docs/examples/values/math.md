```ts tve
import { math } from "tve";

// 距离判定用平方（免开方）
math.distanceSq(math.zero, math.v3(3, 4, 0)); // => 25

// 插值与移动
math.lerp(math.zero, math.v3(10, 0, 0), 0.5);        // => {"x":5,"y":0,"z":0}
math.moveTowards(math.zero, math.v3(10, 0, 0), 3);   // => {"x":3,"y":0,"z":0}
math.equals(math.v3(0, 0, 0), math.v3(1e-9, 0, 0));  // => true（缺省 1e-6 容差）

// 标量与角度（度制，与 Entity.rotation 同约定）
math.clamp(15, 0, 10);              // => 10
math.deltaAngle(359, 0);            // => 1（最短方向）
math.moveTowardsAngle(170, 190, 5); // => 175
math.deadZone(0.05, 0.15);          // => 0（死区内归零）
math.degToRad(180);                 // => 3.141592653589793
math.radToDeg(Math.PI / 2);         // => 90

// 矩阵（列主序 16 数组）
math.mat4().length; // => 16
```

在组件里配合帧参数的典型用法：

```ts tve
import { Component, property, math, MeshNode } from "tve";

export default class Follow extends Component {
  @property({ type: MeshNode, label: "跟随目标" })
  target: MeshNode | null = null;

  @property({ label: "速度（米/秒）", min: 0 })
  speed = 3;

  onUpdate(delta: number) {
    if (!this.target) return;
    // 匀速逼近目标（帧率无关）
    this.entity.position = math.moveTowards(
      this.entity.position,
      this.target.position,
      this.speed * delta,
    );
  }
}
```
