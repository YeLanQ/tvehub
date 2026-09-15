// ---------------------------------------------------------------------------
// engine API：logic（状态机/行为树）控制接口。
// 脚本经 engine.logic 调用；按实体寻址，转发到宿主后端（runtime/logic.mjs 的
// createLogic 产物）。状态机事件/动作处理器回调里可安全操作实体（脚本宿主在
// logic.update 之前跑 onUpdate）。
// ---------------------------------------------------------------------------
import { state } from "./state";

/** 状态快照（引擎自有形状） */
interface LogicStateInfo {
  id: string;
  name: string;
  time: number;
}

function host() {
  return state.host?.logic ?? null;
}

const logicApi = {
  // —— 状态机 ——
  /** 状态机当前状态（未绑定/未就绪 null） */
  fsmState(entity): LogicStateInfo | null {
    return host()?.fsmStateOf(entity?.id) ?? null;
  },
  /** 发射状态机事件（进入当前状态以来的首次发射有效） */
  fire(entity, event) {
    host()?.fire(entity?.id, String(event ?? ""));
  },
  setFsmParam(entity, name, value) {
    host()?.setFsmParam(entity?.id, String(name ?? ""), value);
  },
  getFsmParam(entity, name) {
    return host()?.getFsmParam(entity?.id, String(name ?? ""));
  },
  /** 强制切换状态（stateId 或状态名；未知忽略） */
  forceFsmState(entity, stateId) {
    host()?.forceState(entity?.id, String(stateId ?? ""));
  },
  /** 订阅状态进入（match = 状态 id/名，空 = 任意；返回解绑函数） */
  onFsmEnter(entity, match, cb) {
    return host()?.onFsmEnter(entity?.id, String(match ?? ""), cb) ?? (() => {});
  },
  /** 订阅状态退出（参数同 onFsmEnter） */
  onFsmExit(entity, match, cb) {
    return host()?.onFsmExit(entity?.id, String(match ?? ""), cb) ?? (() => {});
  },
  /** 订阅任意过渡（cb(from, to)；返回解绑函数） */
  onFsmTransition(entity, cb) {
    return host()?.onFsmTransition(entity?.id, cb) ?? (() => {});
  },

  // —— 行为树 ——
  /** 行为树整树最近一次 tick 结果（"success" | "failure" | "running" | null） */
  btStatus(entity) {
    return host()?.btStatusOf(entity?.id) ?? null;
  },
  setBtParam(entity, name, value) {
    host()?.setBtParam(entity?.id, String(name ?? ""), value);
  },
  getBtParam(entity, name) {
    return host()?.getBtParam(entity?.id, String(name ?? ""));
  },
  /**
   * 注册动作叶处理器（动作名；后注册覆盖；返回解绑函数）。
   * handler(leaf, session) 返回 "success"/"failure"/"running"（缺省 success）；
   * session.seq 在动作被重启（上一帧 running、本帧未被求值）时自增，
   * 有状态的动作据此复位自身状态。
   */
  onAction(entity, name, handler) {
    return host()?.onAction(entity?.id, String(name ?? ""), handler) ?? (() => {});
  },

  // —— 通用 ——
  /** 运行开关（暂停/恢复该实体上的运行器；恢复时未启动则从入口开始） */
  setRunning(entity, running) {
    host()?.setRunning(entity?.id, running !== false);
  },
  /** 重启（状态回入口/黑板回默认/清运行记忆） */
  restart(entity) {
    host()?.restart(entity?.id);
  },
};

export { logicApi };
