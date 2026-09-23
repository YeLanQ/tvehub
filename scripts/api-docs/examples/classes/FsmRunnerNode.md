```ts tve
import { Component, property, FsmRunnerNode, engine, LogicStateInfo } from "tve";

// 状态机运行器节点（编辑器 fsmRunnerNode，绑定 .fsm 资产）；
// 控制统一走 engine.logic（按实体寻址），本句柄是普通 Entity 子类
export default class Guard extends Component {
  @property({ type: FsmRunnerNode, label: "守卫状态机" })
  brain: FsmRunnerNode | null = null;

  onStart() {
    if (!this.brain) return;
    // 发射事件（事件过渡触发器：进入当前状态以来的首次发射有效）
    engine.logic.fire(this.brain, "onSeen");

    // 写条件过渡的黑板参数（布尔按 0/1 参与比较）
    engine.logic.setFsmParam(this.brain, "alert", 1);

    // 订阅状态进入（match = 状态 id 或显示名，空串 = 任意）
    const off = engine.logic.onFsmEnter(this.brain, "Chase", (s: LogicStateInfo) => {
      engine.log("进入追击", s.name, "已停留", s.time);
    });
    // off(); // 解绑
  }

  onUpdate() {
    if (!this.brain) return;
    // 当前状态快照（未绑定/未启动 null）
    const st = engine.logic.fsmState(this.brain);
    // 读黑板参数（未定义 undefined）
    const alert = engine.logic.getFsmParam(this.brain, "alert");
    // 强制切状态（不经触发器；stateId 或状态名）
    if (st && st.time > 10) engine.logic.forceFsmState(this.brain, "Patrol");
    void alert;
  }
}
```
