```ts tve
import { Component, property, BtRunnerNode, engine } from "tve";

// 行为树运行器节点（编辑器 btRunnerNode，绑定 .bt 资产）；控制走 engine.logic
export default class Hunter extends Component {
  @property({ type: BtRunnerNode, label: "猎人行为树" })
  brain: BtRunnerNode | null = null;

  private lastSeq = -1;
  private step = 0;

  onStart() {
    if (!this.brain) return;
    // 写黑板（条件叶子的求值对象）
    engine.logic.setBtParam(this.brain, "hunger", 80);

    // 注册动作叶处理器（按动作名；返回三值状态，缺省视为 success）
    engine.logic.onAction(this.brain, "walkTo", (leaf, session) => {
      // seq = 求值代际：动作重新开始自增，running 续行不变——据此复位内部状态
      if (session.seq !== this.lastSeq) {
        this.lastSeq = session.seq;
        this.step = 0;
      }
      return ++this.step >= 10 ? "success" : "running";
    });
  }

  onUpdate() {
    if (!this.brain) return;
    // 整树最近一次 tick 结果
    const status = engine.logic.btStatus(this.brain); // "success" | "failure" | "running" | null
    // 读黑板 / 通用控制
    void engine.logic.getBtParam(this.brain, "hunger");
    if (status === "failure") engine.logic.restart(this.brain); // 重启（黑板回默认）
    // engine.logic.setRunning(this.brain, false);  // 暂停（恢复时未启动则从入口开始）
  }
}
```
