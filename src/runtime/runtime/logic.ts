// ---------------------------------------------------------------------------
// 逻辑运行器系统（播放器侧）：把场景里的 fsmRunnerNode / btRunnerNode 绑定到
// .fsm / .bt 资产并逐帧推进。求值器直接复用编辑器 framework/fsm、
// framework/behavior 的纯逻辑实现（FsmRunner/BTRunner 与 parse 收敛），两端
// 行为零漂移——与 layerpass 等双份实现不同，此处求值语义是同一份代码。
//
// - 节点只持设置（资产绑定/autoStart/时间倍率，与编辑器 LogicSystem 同形状）；
//   当前状态/黑板/运行记忆是运行态；
// - 资产 JSON 按 rel 经 resourceLoader 读取（导出产物内含 .fsm/.bt 文本，
//   assets shim 命中；缺失/解析失败该绑定空转并告警一次）；
// - 动作叶子经 onAction 解析：脚本用 engine.logic.onAction(nodeId, name,
//   handler) 注册；未注册的动作按成功处理。处理器第二参 session.seq 在动作
//   子树被重启（上一帧 running、本帧未被求值）时自增，有状态的动作据此复位；
// - 装配：player.mjs 在 createScripts 之前 await createLogic（脚本 onStart 时
//   engine.logic 已可用），帧循环在 scripts.update 之后调 logic.update(dt)。
// ---------------------------------------------------------------------------

import { postLog } from "../core/log";
import { resourceLoader } from "./resource";
import { FsmRunner } from "../../framework/fsm/fsmRuntime";
import { parseFsmGraph } from "../../framework/fsm/fsmTypes";
import { BTRunner } from "../../framework/behavior/behaviorRuntime";
import { parseBehaviorTree } from "../../framework/behavior/behaviorTypes";
import { parseLogicRunnerSettings, unwrapLogicAsset } from "../../framework/logic/types";

/** 状态快照（脚本可读；引擎自有形状，不含 three 对象） */
export interface LogicStateInfo {
  id: string;
  name: string;
  /** 当前状态停留秒数 */
  time: number;
}

/** 动作叶子求值会话：seq 为求值代际，每次全新开始（首次 / 完成后树重启再入 /
 *  被中断后重入）自增；running 续行不变 */
export interface BTActionSession {
  seq: number;
}

/** 动作处理器：返回三值状态（缺省视为 success）；leaf 为动作叶节点数据 */
export type BTActionHandler = (leaf: BTActionLeaf, session: BTActionSession) => string | void;

/** 动作叶子数据（BTRunner 的 BTNode 的脚本可见子集） */
export interface BTActionLeaf {
  id: string;
  action: string;
  node: unknown;
}

/** 状态切换回调（match 为空 = 任意状态；按 id 或显示名匹配） */
type StateMatchCb = (state: LogicStateInfo) => void;

interface FsmCallbacks {
  enter: Array<{ match: string; cb: StateMatchCb }>;
  exit: Array<{ match: string; cb: StateMatchCb }>;
  transition: Array<(from: LogicStateInfo, to: LogicStateInfo) => void>;
}

interface Binding {
  kind: "fsm" | "bt";
  nodeId: string;
  json: Record<string, unknown>;
  obj: unknown;
  asset: string;
  fsm: FsmRunner | null;
  bt: BTRunner | null;
  running: boolean;
  /** 整树最近一次 tick 结果（btStatusOf 读取） */
  lastBtStatus: string | null;
  fsmCbs: FsmCallbacks;
  /** 动作处理器注册表（动作名 → handler；后注册覆盖） */
  actionHandlers: Map<string, BTActionHandler>;
  /** 本 tick 被求值的动作叶 → 返回状态（tick 后与上一帧 running 集合比对） */
  tickActions: Map<string, string>;
  /** 上一 tick 返回 running 的动作叶（子树重启检测） */
  lastRunning: Set<string>;
  /** 动作叶会话（seq 随重启自增） */
  sessions: Map<string, BTActionSession>;
  missingLogged: boolean;
}

/** 状态机/行为树运行时。由 player 装配（createLogic），engine.logic 转发到这里。 */
export interface LogicApi {
  /** 推进全部运行中的运行器（帧循环调用；dt 秒） */
  update(dt: number): void;
  /** 释放全部绑定与回调（页面卸载） */
  dispose(): void;

  /** 状态机当前状态（未绑定/未就绪 null） */
  fsmStateOf(nodeId: string): LogicStateInfo | null;
  /** 行为树整树最近一次 tick 结果 */
  btStatusOf(nodeId: string): string | null;
  /** 运行开关（暂停/恢复；恢复时未启动则从入口开始） */
  setRunning(nodeId: string, running: boolean): void;
  /** 重启（状态回入口/黑板回默认/清运行记忆） */
  restart(nodeId: string): void;

  /** 发射状态机事件 */
  fire(nodeId: string, event: string): void;
  setFsmParam(nodeId: string, name: string, value: number | boolean): void;
  getFsmParam(nodeId: string, name: string): number | boolean | undefined;
  /** 强制切换状态（stateId 或状态名；未知忽略） */
  forceState(nodeId: string, state: string): void;
  /** 订阅状态进入（match = 状态 id/名，空 = 任意；返回解绑函数） */
  onFsmEnter(nodeId: string, match: string, cb: StateMatchCb): () => void;
  /** 订阅状态退出（参数同 onFsmEnter） */
  onFsmExit(nodeId: string, match: string, cb: StateMatchCb): () => void;
  /** 订阅任意过渡（cb(from, to)） */
  onFsmTransition(nodeId: string, cb: (from: LogicStateInfo, to: LogicStateInfo) => void): () => void;

  setBtParam(nodeId: string, name: string, value: number | boolean): void;
  getBtParam(nodeId: string, name: string): number | boolean | undefined;
  /** 注册动作叶处理器（动作名；后注册覆盖；返回解绑函数） */
  onAction(nodeId: string, name: string, handler: BTActionHandler): () => void;
}

/**
 * 创建逻辑运行时：收集场景中的运行器节点，异步加载资产并构建求值器。
 * 必须在 createScripts 之前 await 完成（脚本 onStart 时 engine.logic 可用）。
 */
export async function createLogic({ nodes }: { nodes: Array<{ json: any; obj: any }> }): Promise<LogicApi> {
  const bindings = new Map<string, Binding>();

  // —— 收集运行器节点（注册表为文档序）——
  for (const { json, obj } of nodes) {
    const type = json?.type;
    if (type !== "fsmRunnerNode" && type !== "btRunnerNode") continue;
    const kind = type === "fsmRunnerNode" ? "fsm" : "bt";
    const settings = parseLogicRunnerSettings(json.settings, kind === "fsm" ? ".fsm" : ".bt");
    const binding: Binding = {
      kind,
      nodeId: typeof json.id === "string" ? json.id : "",
      json,
      obj,
      asset: settings.asset,
      fsm: null,
      bt: null,
      running: settings.autoStart,
      lastBtStatus: null,
      fsmCbs: { enter: [], exit: [], transition: [] },
      actionHandlers: new Map(),
      tickActions: new Map(),
      lastRunning: new Set(),
      sessions: new Map(),
      missingLogged: false,
    };
    if (!binding.nodeId) continue;
    bindings.set(binding.nodeId, binding);
    // 速度等设置在 json 上即时读取（检查器式热调不重建运行态）；此处仅资产绑定
    void settings.speed;
    if (binding.asset) void loadAsset(binding);
  }

  async function loadAsset(binding: Binding): Promise<void> {
    const rel = binding.asset;
    binding.fsm = null;
    binding.bt = null;
    if (!rel) return;
    let text: string | null = null;
    try {
      text = await resourceLoader.loadText(rel);
    } catch {
      text = null;
    }
    if (binding.asset !== rel) return; // 期间换绑（运行时不支持热换绑，防御）
    if (text === null) {
      if (!binding.missingLogged) {
        binding.missingLogged = true;
        postLog("warn", `[logic] 逻辑资产缺失: ${rel}（运行器空转）`);
      }
      return;
    }
    try {
      const doc = unwrapLogicAsset(JSON.parse(text), binding.kind);
      if (binding.kind === "fsm") {
        const fsm = new FsmRunner(parseFsmGraph(doc), {
          onEnter: (state) => dispatchState(binding.fsmCbs.enter, state, binding),
          onExit: (state) => dispatchState(binding.fsmCbs.exit, state, binding),
          onTransition: (from, to) => {
            const f = stateInfo(from, binding);
            const t = stateInfo(to, binding);
            for (const cb of binding.fsmCbs.transition) {
              try {
                cb(f, t);
              } catch (e) {
                postLog("error", `[logic] onFsmTransition 回调出错: ${eText(e)}`);
              }
            }
          },
        });
        binding.fsm = fsm;
        if (binding.running) fsm.start();
      } else {
        const root = parseBehaviorTree(doc);
        if (root) {
          const bt = new BTRunner(root);
          bt.onAction = (node) => runAction(binding, node);
          binding.bt = bt;
        }
      }
    } catch (e) {
      if (!binding.missingLogged) {
        binding.missingLogged = true;
        postLog("error", `[logic] 逻辑资产解析失败: ${rel}（${eText(e)}）`);
      }
    }
  }

  // —— 动作叶子（注册处理器 + 会话代际）——

  function runAction(binding: Binding, node: { id: string; action?: string }): string {
    const name = node.action ?? "";
    binding.tickActions.set(node.id, "");
    const handler = binding.actionHandlers.get(name);
    if (!handler) return "success"; // 未注册动作按成功处理（与编辑器同语义）
    let session = binding.sessions.get(node.id);
    if (!session) {
      session = { seq: 0 };
      binding.sessions.set(node.id, session);
    }
    // 全新一次求值（首次 / 完成后树重启再入 / 被中断后重入）→ 代际自增；
    // running 续行时 seq 不变，处理器比对 seq 即知需复位自身状态
    if (!binding.lastRunning.has(node.id)) session.seq += 1;
    const leaf: BTActionLeaf = { id: node.id, action: name, node };
    try {
      const st = handler(leaf, session);
      const status = st ?? "success";
      binding.tickActions.set(node.id, status);
      return status;
    } catch (e) {
      postLog("error", `[logic] 动作 ${name} 处理器出错（按失败处理）: ${eText(e)}`);
      binding.tickActions.set(node.id, "failure");
      return "failure";
    }
  }

  /** tick 后维护 running 集合（下一帧据此判定动作是否全新开始） */
  function settleActions(binding: Binding): void {
    binding.lastRunning.clear();
    for (const [id, st] of binding.tickActions) {
      if (st === "running") binding.lastRunning.add(id);
    }
    binding.tickActions.clear();
  }

  function dispatchState(list: Array<{ match: string; cb: StateMatchCb }>, state: any, binding: Binding): void {
    const info = stateInfo(state, binding);
    for (const { match, cb } of list) {
      if (match && match !== info.id && match !== info.name) continue;
      try {
        cb(info);
      } catch (e) {
        postLog("error", `[logic] 状态回调出错: ${eText(e)}`);
      }
    }
  }

  function stateInfo(state: { id: string; name: string }, binding: Binding): LogicStateInfo {
    const fsm = binding.fsm;
    return { id: state.id, name: state.name, time: fsm ? fsm.stateTime : 0 };
  }

  // —— 控制面（engine.logic 转发到这里；全部按 nodeId 寻址）——

  const api: LogicApi = {
    update(dt) {
      if (!dt || dt <= 0) return;
      for (const binding of bindings.values()) {
        const speed = speedOf(binding);
        if (binding.kind === "fsm" && binding.fsm) {
          if (!binding.running) continue;
          if (!binding.fsm.started) binding.fsm.start();
          binding.fsm.update(dt * speed);
        } else if (binding.kind === "bt" && binding.bt) {
          if (!binding.running) continue;
          binding.lastBtStatus = binding.bt.tick(dt * speed);
          settleActions(binding);
        }
      }
    },
    dispose() {
      for (const binding of bindings.values()) {
        binding.fsmCbs.enter.length = 0;
        binding.fsmCbs.exit.length = 0;
        binding.fsmCbs.transition.length = 0;
        binding.actionHandlers.clear();
        binding.fsm = null;
        binding.bt = null;
      }
      bindings.clear();
    },

    fsmStateOf(nodeId) {
      const b = bindings.get(nodeId);
      if (!b?.fsm?.started) return null;
      const st = b.fsm.state;
      return st ? { id: st.id, name: st.name, time: b.fsm.stateTime } : null;
    },
    btStatusOf(nodeId) {
      const b = bindings.get(nodeId);
      return b?.bt ? b.lastBtStatus : null;
    },
    setRunning(nodeId, running) {
      const b = bindings.get(nodeId);
      if (!b || b.running === running) return;
      b.running = running;
      if (running && b.fsm && !b.fsm.started) b.fsm.start();
    },
    restart(nodeId) {
      const b = bindings.get(nodeId);
      if (!b) return;
      if (b.fsm) {
        b.fsm.reset();
        b.fsm.params = { ...b.fsm.graph.params };
        if (b.running) b.fsm.start();
      }
      if (b.bt) {
        b.bt.reset();
        b.bt.blackboard = {};
      }
      b.lastRunning.clear();
      b.tickActions.clear();
      b.sessions.clear();
    },

    fire(nodeId, event) {
      const b = bindings.get(nodeId);
      if (b?.fsm && event) b.fsm.fire(event);
    },
    setFsmParam(nodeId, name, value) {
      const b = bindings.get(nodeId);
      if (b?.fsm && name) b.fsm.setParam(name, value);
    },
    getFsmParam(nodeId, name) {
      const b = bindings.get(nodeId);
      return b?.fsm ? b.fsm.params[name] : undefined;
    },
    forceState(nodeId, state) {
      const b = bindings.get(nodeId);
      if (!b?.fsm || !state) return;
      const id = b.fsm.graph.states.find((s) => s.id === state || s.name === state)?.id;
      if (id) b.fsm.forceState(id);
    },
    onFsmEnter(nodeId, match, cb) {
      return subscribeState(bindings, nodeId, "enter", match, cb);
    },
    onFsmExit(nodeId, match, cb) {
      return subscribeState(bindings, nodeId, "exit", match, cb);
    },
    onFsmTransition(nodeId, cb) {
      const b = bindings.get(nodeId);
      if (!b) return () => {};
      b.fsmCbs.transition.push(cb);
      return () => {
        const i = b.fsmCbs.transition.indexOf(cb);
        if (i >= 0) b.fsmCbs.transition.splice(i, 1);
      };
    },

    setBtParam(nodeId, name, value) {
      const b = bindings.get(nodeId);
      if (b?.bt && name) b.bt.blackboard[name] = value;
    },
    getBtParam(nodeId, name) {
      const b = bindings.get(nodeId);
      return b?.bt ? b.bt.blackboard[name] : undefined;
    },
    onAction(nodeId, name, handler) {
      const b = bindings.get(nodeId);
      if (!b || !name || typeof handler !== "function") return () => {};
      b.actionHandlers.set(name, handler);
      return () => {
        if (b.actionHandlers.get(name) === handler) b.actionHandlers.delete(name);
      };
    },
  };

  return api;
}

function subscribeState(
  bindings: Map<string, Binding>,
  nodeId: string,
  slot: "enter" | "exit",
  match: string,
  cb: StateMatchCb,
): () => void {
  const b = bindings.get(nodeId);
  if (!b) return () => {};
  const entry = { match: match ?? "", cb };
  b.fsmCbs[slot].push(entry);
  return () => {
    const list = b.fsmCbs[slot];
    const i = list.indexOf(entry);
    if (i >= 0) list.splice(i, 1);
  };
}

/** 时间倍率从节点 JSON 即时读取（检查器式热调即时生效；与 parse 收敛同域） */
function speedOf(binding: Binding): number {
  const raw = (binding.json?.settings as { speed?: unknown } | undefined)?.speed;
  const v = typeof raw === "number" && Number.isFinite(raw) ? raw : 1;
  return Math.min(20, Math.max(0.05, v));
}

function eText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
