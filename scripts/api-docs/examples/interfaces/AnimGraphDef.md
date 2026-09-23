```ts tve
import { Component, SkeletalAnimation, AnimGraphDef } from "tve";

export default class Locomotion extends Component {
  anim!: SkeletalAnimation; // 组件字段：运行期自动绑定门面

  onStart() {
    // 动画图定义：状态（模型内嵌剪辑名）+ 条件过渡 + 参数表
    const graph: AnimGraphDef = {
      entry: "Idle",
      states: [
        { name: "Idle", clip: "idle", loop: "loop" },
        { name: "Walk", clip: "walk", speed: 1.2 },
        { name: "Run", clip: "run" },
      ],
      transitions: [
        { from: "Idle", to: "Walk", duration: 0.2, conditions: [{ param: "speed", op: ">", value: 0.1 }] },
        { from: "Walk", to: "Run", duration: 0.25, exitTime: 0.5, conditions: [{ param: "speed", op: ">", value: 5 }] },
        { from: "Run", to: "Idle", duration: 0.3 },
      ],
      params: { speed: 0 },
    };
    if (this.anim.ensureGraph(graph)) {
      // 参数写入驱动条件过渡（每帧评估）
      this.anim.setParam("speed", 6);
    }
  }

  onUpdate() {
    // 运行期活对象可直接改写（下一帧评估生效）
    if (this.anim.graph) {
      this.anim.graph.params!.speed = 2;
    }
    // 图模式下 play(状态名) 切换；getParam 读取
    void this.anim.getParam("speed");
  }
}
```
