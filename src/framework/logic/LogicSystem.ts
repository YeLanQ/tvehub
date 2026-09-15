// ---------------------------------------------------------------------------
// 逻辑系统（framework 层）：状态机/行为树运行器节点与运行态的绑定同步。
//
// - 运行器节点（fsmRunnerNode/btRunnerNode）只持设置（资产绑定 + autoStart +
//   时间倍率）；当前状态、黑板、运行记忆是运行态，不序列化——与导航代理的
//   路径同约定；
// - 资产内容经 providers.assetText 异步读取（应用层注入 api.readText），加载
//   完成后 parse 出图并构建求值器；绑定资产变化或资产保存（invalidateAsset）
//   时热重建求值器（与材质/着色器文档的 fetcher + 失效缓存同套路）；
// - update(dt) 推进全部运行中的运行器；状态切换/树状态变化经 onChange 上抛，
//   由 EditorEngine 广播 "logic:changed" 供检查器刷新视图；
// - 求值器本体（FsmRunner/BTRunner）是纯逻辑（framework/fsm、framework/
//   behavior），播放器侧 runtime/runtime/logic.ts 复用同一实现，本系统只负责
//   编辑器侧的绑定、驱动与状态视图。
// ---------------------------------------------------------------------------

import type { Object3D } from "three";

import { FsmRunner, parseFsmGraph, type FsmGraph, type FsmParamValue, type FsmState } from "../fsm";
import {
  BTRunner,
  parseBehaviorTree,
  type BTBlackboardValue,
  type BTNode,
  type BTStatus,
} from "../behavior";
import {
  cloneLogicRunnerSettings,
  parseLogicRunnerSettings,
  unwrapLogicAsset,
  type LogicRunnerSettings,
} from "./types";
import type { FsmRunnerNode } from "../prototype/nodes/FsmRunnerNode";
import type { BtRunnerNode } from "../prototype/nodes/BtRunnerNode";

/** 逻辑资产文本读取器（应用层注入；读取失败/无项目返回 null） */
export type LogicAssetFetcher = (rel: string) => Promise<string | null>;

/** 状态机运行器状态视图（检查器展示） */
export interface FsmRunnerView {
  /** 是否已绑定资产（settings.asset 非空） */
  bound: boolean;
  /** 资产读取/解析失败（绑定存在但内容不可用） */
  assetMissing: boolean;
  /** 求值器是否就绪（资产已解析） */
  ready: boolean;
  /** 是否在推进（检查器暂停开关） */
  running: boolean;
  /** 求值器是否已 start */
  started: boolean;
  stateId: string;
  stateName: string;
  /** 当前状态停留秒数 */
  stateTime: number;
  /** 图规模（检查器摘要） */
  stateCount: number;
  transitionCount: number;
  /** 运行参数黑板（副本；检查器编辑经 setFsmParam） */
  params: Record<string, FsmParamValue>;
  /** 最近一次过渡（from → to，触发方式摘要；无则 null） */
  lastTransition: { from: string; to: string; via: string } | null;
}

/** 行为树运行器状态视图（检查器展示） */
export interface BtRunnerView {
  bound: boolean;
  assetMissing: boolean;
  ready: boolean;
  running: boolean;
  /** 整树最近一次 tick 结果（未就绪 null） */
  status: BTStatus | null;
  nodeCount: number;
  /** 黑板（副本；检查器编辑经 setBtParam） */
  blackboard: Record<string, BTBlackboardValue>;
  /** 最近一次被求值的动作叶子名（未注册动作按成功处理） */
  lastAction: string;
}

type LogicKind = "fsm" | "bt";

interface RunnerBinding {
  kind: LogicKind;
  node: FsmRunnerNode | BtRunnerNode;
  objUuid: string;
  settings: LogicRunnerSettings;
  /** 已加载的资产文本与内容签名（invalidateAsset 失效重读） */
  assetRel: string;
  assetText: string | null;
  assetMissing: boolean;
  loading: boolean;
  fsm: FsmRunner | null;
  bt: BTRunner | null;
  /** 是否推进（首绑取 autoStart；检查器可暂停/继续） */
  running: boolean;
  /** 视图增量（bt 最近 tick 结果 / fsm 最近过渡 / 最近动作），变化才 notify */
  lastBtStatus: BTStatus | null;
  lastTransition: { from: string; to: string; via: string } | null;
  lastAction: string;
}

export class LogicSystem {
  /** 资产文本读取器（应用层项目打开时注入；null = 不可读，绑定空转） */
  private fetcher: LogicAssetFetcher | null = null;

  /** 注入资产文本读取器（与材质/着色器文档的 setFetcher 同套路） */
  setFetcher(f: LogicAssetFetcher | null): void {
    this.fetcher = f;
  }

  /** 运行时变化回调（绑定/就绪/状态切换/数据写入；EditorEngine 转事件） */
  onChange: ((nodeId: string) => void) | null = null;

  private bindings = new Map<string, RunnerBinding>();

  // ===================== 绑定 =====================

  /** 注册/更新状态机运行器（绑定资产变化时热重建求值器） */
  syncFsm(node: FsmRunnerNode, obj: Object3D): void {
    this.syncRunner("fsm", node, obj);
  }

  /** 注册/更新行为树运行器 */
  syncBt(node: BtRunnerNode, obj: Object3D): void {
    this.syncRunner("bt", node, obj);
  }

  private syncRunner(kind: LogicKind, node: FsmRunnerNode | BtRunnerNode, obj: Object3D): void {
    const ext = kind === "fsm" ? ".fsm" : ".bt";
    const settings = parseLogicRunnerSettings(node.settings, ext);
    const existing = this.bindings.get(node.id);
    if (existing && existing.kind === kind && existing.objUuid === obj.uuid) {
      existing.node = node;
      existing.settings = cloneLogicRunnerSettings(settings);
      // 绑定资产未变：设置（autoStart/speed）即时生效，不重建运行态
      if (settings.asset === existing.assetRel) return;
      existing.running = settings.autoStart;
      this.loadAsset(existing, settings.asset);
      return;
    }
    const binding: RunnerBinding = {
      kind,
      node,
      objUuid: obj.uuid,
      settings: cloneLogicRunnerSettings(settings),
      assetRel: settings.asset,
      assetText: null,
      assetMissing: false,
      loading: false,
      fsm: null,
      bt: null,
      running: settings.autoStart,
      lastBtStatus: null,
      lastTransition: null,
      lastAction: "",
    };
    this.bindings.set(node.id, binding);
    if (binding.assetRel) this.loadAsset(binding, binding.assetRel);
    else this.notify(node.id);
  }

  unbind(nodeId: string): void {
    if (this.bindings.delete(nodeId)) this.notify(nodeId);
  }

  /** 解除全部绑定（场景整体重建/切换：运行态不跨场景保留） */
  unbindAll(): void {
    if (!this.bindings.size) return;
    this.bindings.clear();
    this.notify("");
  }

  // ===================== 资产 =====================

  /** 资产保存后热重建：重读文本并重建引用该资产的求值器（运行开关保持） */
  invalidateAsset(rel: string): void {
    if (!rel) return;
    const lower = rel.toLowerCase();
    for (const binding of this.bindings.values()) {
      if (binding.assetRel.toLowerCase() !== lower) continue;
      this.loadAsset(binding, binding.assetRel);
    }
  }

  /** 读取资产文本 → 解析建求值器（换绑/解绑/再失效以当前绑定状态为准） */
  private loadAsset(binding: RunnerBinding, rel: string): void {
    binding.assetRel = rel;
    binding.assetText = null;
    binding.assetMissing = false;
    binding.fsm = null;
    binding.bt = null;
    binding.lastBtStatus = null;
    binding.lastTransition = null;
    binding.lastAction = "";
    if (!rel) {
      this.notify(binding.node.id);
      return;
    }
    const fetcher = this.fetcher;
    if (!fetcher) {
      binding.assetMissing = true;
      this.notify(binding.node.id);
      return;
    }
    binding.loading = true;
    this.notify(binding.node.id);
    void fetcher(rel).then((text) => {
      // 异步返回前可能已解绑/换绑/再次失效：全部以当前绑定状态为准
      if (this.bindings.get(binding.node.id) !== binding) return;
      binding.loading = false;
      if (binding.assetRel !== rel) {
        this.loadAsset(binding, binding.assetRel);
        return;
      }
      if (text === null) {
        binding.assetMissing = true;
        this.notify(binding.node.id);
        return;
      }
      binding.assetText = text;
      this.buildRunner(binding);
      this.notify(binding.node.id);
    });
  }

  /** 由已加载文本构建求值器（解析失败按资产缺失处理，绑定保留待热更新） */
  private buildRunner(binding: RunnerBinding): void {
    binding.fsm = null;
    binding.bt = null;
    binding.lastBtStatus = null;
    binding.lastTransition = null;
    binding.lastAction = "";
    if (!binding.assetText) return;
    try {
      if (binding.kind === "fsm") {
        const graph = parseFsmGraph(unwrapLogicAsset(JSON.parse(binding.assetText), "fsm"));
        const fsm = new FsmRunner(graph, {
          onTransition: (from, to, via) => {
            binding.lastTransition = { from: from.name, to: to.name, via: transitionVia(via) };
            this.notify(binding.node.id);
          },
        });
        binding.fsm = fsm;
        if (binding.running) fsm.start();
      } else {
        const root = parseBehaviorTree(unwrapLogicAsset(JSON.parse(binding.assetText), "bt"));
        if (root) {
          const bt = new BTRunner(root);
          // 动作叶子每次求值都记录（不 notify：动作逐帧求值，太吵；
          // 检查器在下一次任意刷新时读到最新值）
          bt.onAction = (node) => {
            if (node.action) binding.lastAction = node.action;
          };
          binding.bt = bt;
        } else {
          binding.assetMissing = true;
        }
      }
    } catch {
      binding.assetMissing = true;
    }
  }

  // ===================== 推进 =====================

  /** 推进全部运行中的运行器（编辑器渲染回调调用；dt ≤ 0 跳过） */
  update(dt: number): void {
    if (dt <= 0) return;
    for (const binding of this.bindings.values()) {
      if (!binding.running) continue;
      const scaled = dt * binding.settings.speed;
      if (binding.kind === "fsm" && binding.fsm) {
        if (!binding.fsm.started) binding.fsm.start();
        binding.fsm.update(scaled);
      } else if (binding.kind === "bt" && binding.bt) {
        const st = binding.bt.tick(scaled);
        if (st !== binding.lastBtStatus) {
          binding.lastBtStatus = st;
          this.notify(binding.node.id);
        }
      }
    }
  }

  // ===================== 视图与控制（检查器/命令） =====================

  /** 状态机运行器视图（该节点非状态机运行器返回 null） */
  getFsmView(nodeId: string): FsmRunnerView | null {
    const b = this.bindings.get(nodeId);
    if (!b || b.kind !== "fsm") return null;
    const g = b.fsm?.graph ?? null;
    return {
      bound: !!b.settings.asset,
      assetMissing: b.assetMissing,
      ready: !!b.fsm,
      running: b.running,
      started: !!b.fsm?.started,
      stateId: b.fsm?.state?.id ?? "",
      stateName: b.fsm?.stateName ?? "",
      stateTime: b.fsm?.stateTime ?? 0,
      stateCount: g?.states.length ?? 0,
      transitionCount: g?.transitions.length ?? 0,
      params: b.fsm ? { ...b.fsm.params } : {},
      lastTransition: b.lastTransition,
    };
  }

  /** 行为树运行器视图（该节点非行为树运行器返回 null） */
  getBtView(nodeId: string): BtRunnerView | null {
    const b = this.bindings.get(nodeId);
    if (!b || b.kind !== "bt") return null;
    let nodeCount = 0;
    if (b.bt?.root) {
      const walk = (n: BTNode): void => {
        nodeCount += 1;
        for (const c of n.children) walk(c);
      };
      walk(b.bt.root);
    }
    return {
      bound: !!b.settings.asset,
      assetMissing: b.assetMissing,
      ready: !!b.bt,
      running: b.running,
      status: b.lastBtStatus,
      nodeCount,
      blackboard: b.bt ? { ...b.bt.blackboard } : {},
      lastAction: b.lastAction,
    };
  }

  /** 运行开关（检查器暂停/继续；不重建求值器，恢复时未启动则从入口开始） */
  setRunning(nodeId: string, running: boolean): void {
    const b = this.bindings.get(nodeId);
    if (!b || b.running === running) return;
    b.running = running;
    if (running && b.fsm && !b.fsm.started) b.fsm.start();
    this.notify(nodeId);
  }

  /** 重启：重建运行态（状态回入口、黑板回默认值；运行开关保持） */
  restart(nodeId: string): void {
    const b = this.bindings.get(nodeId);
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
    b.lastBtStatus = null;
    b.lastTransition = null;
    this.notify(nodeId);
  }

  /** 发射状态机事件（进入当前状态以来的首次发射有效） */
  fireFsmEvent(nodeId: string, event: string): void {
    const b = this.bindings.get(nodeId);
    if (b?.fsm && event) {
      b.fsm.fire(event);
      this.notify(nodeId);
    }
  }

  /** 写状态机运行参数 */
  setFsmParam(nodeId: string, name: string, value: FsmParamValue): void {
    const b = this.bindings.get(nodeId);
    if (b?.fsm && name) {
      b.fsm.setParam(name, value);
      this.notify(nodeId);
    }
  }

  /** 写行为树黑板 */
  setBtParam(nodeId: string, name: string, value: BTBlackboardValue): void {
    const b = this.bindings.get(nodeId);
    if (b?.bt && name) {
      b.bt.blackboard[name] = value;
      this.notify(nodeId);
    }
  }

  /** 强制切换状态机状态（不经触发器；未知 id 忽略） */
  forceFsmState(nodeId: string, stateId: string): void {
    const b = this.bindings.get(nodeId);
    if (b?.fsm && stateId) {
      b.fsm.forceState(stateId);
      this.notify(nodeId);
    }
  }

  /** 状态机图（检查器强制切换下拉用；未就绪 null） */
  fsmGraph(nodeId: string): FsmGraph | null {
    return this.bindings.get(nodeId)?.fsm?.graph ?? null;
  }

  /** 状态 id → 状态（编辑器辅助） */
  fsmState(nodeId: string, stateId: string): FsmState | null {
    const g = this.fsmGraph(nodeId);
    return g ? g.states.find((s) => s.id === stateId) ?? null : null;
  }

  private notify(nodeId: string): void {
    this.onChange?.(nodeId);
  }
}

/** 过渡触发方式摘要（检查器「最近过渡」列） */
function transitionVia(t: { event: string; duration: number; conditions: unknown[] }): string {
  if (t.event) return `事件 ${t.event}`;
  if (t.duration > 0) return `定时 ${t.duration}s`;
  if (t.conditions.length > 0) return "条件满足";
  return "立即";
}
