```ts tve
import { Component, property, FsmRunnerNode, BtRunnerNode, engine, LogicStateInfo, BTStatus } from "tve";

export default class BrainControl extends Component {
  @property({ type: FsmRunnerNode, label: "状态机" })
  fsm: FsmRunnerNode | null = null;

  @property({ type: BtRunnerNode, label: "行为树" })
  bt: BtRunnerNode | null = null;

  onStart() {
    // —— 状态机（fsmRunnerNode 实体）——
    if (this.fsm) {
      const st: LogicStateInfo | null = engine.logic.fsmState(this.fsm);
      void st;                                    // {id,name,time} 或 null
      engine.logic.fire(this.fsm, "onSeen");      // 发射事件
      engine.logic.setFsmParam(this.fsm, "hp", 3);// 写黑板（数值/布尔）
      engine.logic.getFsmParam(this.fsm, "hp");   // 读（未定义 undefined）
      engine.logic.forceFsmState(this.fsm, "Flee");// 强制切状态
      engine.logic.onFsmEnter(this.fsm, "", (s) => { void s; });  // 订阅进入
      engine.logic.onFsmExit(this.fsm, "", (s) => { void s; });   // 订阅退出
      engine.logic.onFsmTransition(this.fsm, (from, to) => { void from; void to; });
    }

    // —— 行为树（btRunnerNode 实体）——
    if (this.bt) {
      const status: BTStatus | null = engine.logic.btStatus(this.bt);
      void status;                                // "success"|"failure"|"running"|null
      engine.logic.setBtParam(this.bt, "hunger", 80);
      engine.logic.getBtParam(this.bt, "hunger");
      engine.logic.onAction(this.bt, "walkTo", (leaf, session) => {
        void leaf.id; void leaf.action; void session.seq;
        return "running" satisfies BTStatus;
      });
    }
  }

  onUpdate() {
    // —— 通用（两类运行器）——
    if (this.fsm) {
      engine.logic.setRunning(this.fsm, true); // 暂停/恢复（恢复时未启动从入口开始）
      engine.logic.restart(this.fsm);          // 重启：状态回入口/黑板回默认/清记忆
    }
  }
}
```
