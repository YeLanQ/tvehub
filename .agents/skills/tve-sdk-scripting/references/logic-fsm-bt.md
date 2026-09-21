# 单元：状态机 / 行为树的脚本控制（engine.logic）

## 契约（速查）

场景里先放 **fsmRunnerNode**（绑 .fsm 资产）或 **btRunnerNode**（绑 .bt 资产），
脚本统一经 `engine.logic: LogicApi`（按实体寻址）控制；运行态不序列化。

FSM：`fsmState(e) → LogicStateInfo{id,name,time}|null`、`fire(e, event)`（事件过渡
触发器；进入当前状态以来首次发射有效）、`setFsmParam/getFsmParam(e, name, v?)`
（条件过渡黑板；布尔按 0/1）、`forceFsmState(e, stateId)`、
`onFsmEnter/onFsmExit(e, match, cb) → 解绑`（match = 状态 id 或显示名，空 = 任意）、
`onFsmTransition(e, cb(from,to))`。
BT：`btStatus(e) → "success"|"failure"|"running"|null`、`setBtParam/getBtParam`、
`onAction(e, name, handler)`（按动作名注册处理器，后注册覆盖，未注册按成功处理；
handler 返回 "running" 时同叶续行、`session.seq` 不变，重启自增——比对 seq 复位）。
通用：`setRunning(e, running)`（恢复时未启动则从入口开始）、`restart(e)`。

## 模板：FSM 巡逻-追击（订阅状态 + 发事件 + 写参数）

```ts
import { Component, property, engine, FsmRunnerNode, Transform } from "tve";

export default class EnemyBrain extends Component {
  @property({ type: FsmRunnerNode, label: "状态机节点" })
  brain: FsmRunnerNode | null = null;
  @property({ type: Transform, label: "玩家" })
  player: Transform | null = null;
  @property({ label: "索敌距离（米）", min: 0 }) sight = 8;

  private unbinds: Array<() => void> = [];

  onStart() {
    if (!this.brain) return;
    // 状态进入钩子：切动画/音效等（回调里可安全操作实体）
    this.unbinds.push(engine.logic.onFsmEnter(this.brain, "追击", () => {
      engine.log("进入追击");
    }));
    this.unbinds.push(engine.logic.onFsmExit(this.brain, "巡逻", () => {
      engine.log("巡逻结束");
    }));
  }

  onUpdate(_delta: number) {
    if (!this.brain || !this.player) return;
    const d = math_distance(this.entity.worldPosition, this.player.worldPosition);
    // 黑板参数驱动条件过渡（.fsm 里配 distance < 8 之类的条件）
    engine.logic.setFsmParam(this.brain, "playerDist", d);
    // 事件过渡：发现玩家发一次 "seesPlayer"（重复发射在同一状态内被忽略）
    if (d < this.sight) engine.logic.fire(this.brain, "seesPlayer");
  }

  onDestroy() { this.unbinds.forEach((u) => u()); }
}

function math_distance(a: {x:number;y:number;z:number}, b: {x:number;y:number;z:number}) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);   // 或用 tve 的 math.distance
}
```

（实际写脚本直接 `import { math } from "tve"` 用 `math.distance(a, b)`，
上面手写函数仅为让本模板自包含可读。）

## 模板：行为树动作叶（running 续行 + seq 复位）

```ts
import { Component, engine } from "tve";

export default class Walker extends Component {
  private lastSeq = -1;
  private step = 0;

  onStart() {
    // .bt 树里放一个动作叶 action="walkTo"；未注册的动作按成功处理，务必注册
    engine.logic.onAction(this.entity, "walkTo", (leaf, session) => {
      if (session.seq !== this.lastSeq) {    // 动作重新开始 → 复位内部步进
        this.lastSeq = session.seq;
        this.step = 0;
      }
      // 每帧续行走一步；走满 10 步报成功（返回 "running" 引擎下帧再调同叶）
      return ++this.step >= 10 ? "success" : "running";
    });
  }

  onUpdate() {
    // 条件叶读黑板：.bt 条件里引用黑板名，这里写入
    engine.logic.setBtParam(this.entity, "arrived", this.step >= 10);
  }
}
```

## 测试例

- 建议工作流：编辑器「逻辑」面板画 .fsm/.bt（前端收敛 JSON → api.fsmWrite/
  behaviorTreeWrite 落盘）→ 运行器节点绑定 → 本模板脚本挂同一节点控制。
- 回归：`scripts/smoke/tracker/smoke-logic-runtime.mjs`（状态机过渡/黑板/BT 求值）；
  framework 侧解析纯逻辑真实 spec：`src/framework/fsm/fsmTypes.spec.ts`、
  `fsmRuntime.spec.ts`、`src/framework/logic/types.spec.ts`。
