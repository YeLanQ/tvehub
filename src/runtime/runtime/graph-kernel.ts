// ---------------------------------------------------------------------------
// 场景图执行内核（蓝图式 exec 链级联 + 拉模型数据流；类型无关的引擎部分）。
//
// 执行模型（与旧 graph-behaviors 逐路径等价）：
// - 事件入口：eventEntry 能力节点按注册表 trigger 绑定（start=启动级联 /
//   frame=每帧级联链 + 驱动器发现 / click=射线命中级联），无类型特判；
// - cascade 派发顺序：容器行为 → 执行链执行器 → 驱动器（透传级联，帧循环节步）
//   → op 执行器（nodeActive 门控 + 目标集执行）→ 停；
// - 数据流拉模型：data[type] → prefixData[前缀]（custom 表达式）→
//   entitySource/container 能力的 out 引脚实体集回退 → null；
// - 目标解析：resolvers[type]（proto/match）/ 容器作用域 / op·driver 实体集透传
//   上游递归（独立于 exec 链）；
// - 向后兼容：有 op/driver 能力但无 exec 入边的节点按其 trigger 独立执行；
// - 逻辑容器（能力 container）：enter/frame/childActive 由容器行为模块实现，
//   kernel 只负责归属链递归与调度；驱动器实例按 node.id 全局缓存共享。
//
// 类型语义全部在 GraphRuntimeModule（内置见 graph-core-modules.ts，注入模块经
// createGraphBehaviors 第二参数进入）。装配期校验：注册表能力与 handler 表
// 不对齐时告警（缺语义的类型节点跳过执行，不 crash）。
// ---------------------------------------------------------------------------

import * as THREE from "three";
import { hasNodeTypeCapability, nodeTypeDef } from "../../framework/graph";
import type { GNode } from "../../framework/graph";
import { postLog } from "../core/log";
import type {
  ChainExecutor,
  ContainerBehavior,
  DataEvaluator,
  DataValue,
  DriverFactory,
  DriverInstance,
  ExecCtx,
  GraphBehaviorsCtx,
  GraphBehaviorsHandle,
  GraphKernel,
  GraphRuntimeModule,
  NodeObj,
  OpExecutor,
  TargetResolver,
} from "./graph-runtime";

/** 级联空上下文缺省（exec 通道：next → exec） */
const EMPTY_EVENT = "";

export function createGraphKernel(ctx: GraphBehaviorsCtx, modules: GraphRuntimeModule[]): GraphBehaviorsHandle {
  const { scene, dom, camera, logicApi, graph, navApi } = ctx;

  // ----- handler 表合并（后注册模块不覆盖先注册的同键语义） -----
  const ops: Record<string, OpExecutor> = {};
  const drivers: Record<string, DriverFactory> = {};
  const data: Record<string, DataEvaluator> = {};
  const prefixData: Record<string, DataEvaluator> = {};
  const executors: Record<string, ChainExecutor> = {};
  const resolvers: Record<string, TargetResolver> = {};
  const containers: Record<string, ContainerBehavior> = {};
  for (const m of modules) {
    for (const [k2, v] of Object.entries(m.ops ?? {})) ops[k2] ??= v;
    for (const [k2, v] of Object.entries(m.drivers ?? {})) drivers[k2] ??= v;
    for (const [k2, v] of Object.entries(m.data ?? {})) data[k2] ??= v;
    for (const [k2, v] of Object.entries(m.prefixData ?? {})) prefixData[k2] ??= v;
    for (const [k2, v] of Object.entries(m.executors ?? {})) executors[k2] ??= v;
    for (const [k2, v] of Object.entries(m.resolvers ?? {})) resolvers[k2] ??= v;
    for (const [k2, v] of Object.entries(m.containers ?? {})) containers[k2] ??= v;
  }

  // ----- 收集场景节点对象（traverse 含子孙，去重） -----
  const byId = new Map<string, NodeObj>();
  const all: NodeObj[] = [];
  scene.traverse((o) => {
    const id = typeof o.userData?.nodeId === "string" ? o.userData.nodeId : "";
    if (!id || byId.has(id)) return;
    const n: NodeObj = {
      obj: o,
      id,
      kind: typeof o.userData?.nodeKind === "string" ? o.userData.nodeKind : "",
      tag: typeof o.userData?.nodeTag === "string" ? o.userData.nodeTag : "",
    };
    byId.set(id, n);
    all.push(n);
  });

  const nodeOf = (id: string): GNode | undefined => graph.nodes.find((n) => n.id === id);

  /** 诊断告警去重（同一原因只提示一次；经引擎日志通道回传控制台） */
  const warnedKeys = new Set<string>();
  function warnOnce(key: string, msg: string): void {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    postLog("warn", msg);
  }

  // ----- 帧驱动采样（诊断状态；见 update 末尾） -----
  const sampleCounts = new Map<string, number>();
  const SAMPLE_LIMIT = 2;
  const sampleVector = new THREE.Vector3();
  let sampleTimer = 0;

  /** 图内不存在的类型键缓存（避免每节点重复查找注册表） */
  const typeDefOf = (node: GNode) => nodeTypeDef(node.type);

  // ----- 图变量存储（运行时值；从 doc.variables 初始化） -----
  const varStore = new Map<string, DataValue>();
  for (const v of graph.variables ?? []) varStore.set(v.id, v.value);

  // ----- 循环上下文：For/ForEach 当前迭代值 -----
  const loopIndex = new Map<string, number>(); // flow.for node.id → 当前 index
  const loopItem = new Map<string, NodeObj | undefined>(); // flow.forEach node.id → 当前 item

  let elapsed = 0;

  // ----- 参数读取（缺省回退：解析容错） -----
  const numP = (n: GNode, key: string, fb = 0): number => {
    const v = n.params?.[key];
    return typeof v === "number" && Number.isFinite(v) ? v : fb;
  };
  const strP = (n: GNode, key: string, fb = ""): string => {
    const v = n.params?.[key];
    return typeof v === "string" ? v : fb;
  };
  const boolP = (n: GNode, key: string): boolean => n.params?.[key] === true;

  // ---------------------------------------------------------------------------
  // 实体集通道（目标解析，独立于 exec 链）
  // ---------------------------------------------------------------------------

  /** 匹配节点/原型的实体集（resolvers 驱动；容器 out = 自身作用域实体集） */
  function resolveSet(refId: string, seen = new Set<string>()): NodeObj[] {
    if (seen.has(refId)) return [];
    seen.add(refId);
    const node = nodeOf(refId);
    if (!node || node.unresolved) return [];
    const resolver = resolvers[node.type];
    if (resolver) return resolver(kernel, node);
    if (hasNodeTypeCapability(node.type, "container")) return resolveTargets(refId, seen);
    return [];
  }

  /** 操作的目标集：实体集通道上游（op/driver 实体透传 → 递归上游） */
  function resolveTargets(opId: string, seen = new Set<string>()): NodeObj[] {
    if (seen.has(opId)) return [];
    seen.add(opId);
    const out: NodeObj[] = [];
    for (const e of graph.edges) {
      if (e.dstNode !== opId || e.dstPort !== "in") continue;
      const src = nodeOf(e.srcNode);
      if (!src || src.unresolved) continue;
      if (hasNodeTypeCapability(src.type, "op")) out.push(...resolveTargets(src.id, seen));
      else out.push(...resolveSet(src.id));
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // 数据流求值（拉模型）
  // ---------------------------------------------------------------------------

  function evalDataOutput(nodeId: string, portId: string, seen = new Set<string>()): DataValue {
    if (seen.has(`${nodeId}\u0000${portId}`)) return null; // 环防护
    seen.add(`${nodeId}\u0000${portId}`);
    const node = nodeOf(nodeId);
    if (!node || node.unresolved) return null;
    // 类型数据求值器（undefined = 不处理该端口，继续回退）
    const handler = data[node.type];
    if (handler) {
      const v = handler(kernel, node, portId);
      if (v !== undefined) return v;
    } else {
      for (const [prefix, fn] of Object.entries(prefixData)) {
        if (!node.type.startsWith(prefix)) continue;
        const v = fn(kernel, node, portId);
        if (v !== undefined) return v;
        break;
      }
    }
    // 实体集源 / 容器输出：out 引脚 = 自身解析实体集
    if (portId === "out" && (hasNodeTypeCapability(node.type, "entitySource") || hasNodeTypeCapability(node.type, "container"))) {
      return resolveSet(nodeId);
    }
    return null;
  }

  function evalDataInput(nodeId: string, portId: string): DataValue {
    for (const e of graph.edges) {
      if (e.dstNode !== nodeId || e.dstPort !== portId) continue;
      return evalDataOutput(e.srcNode, e.srcPort);
    }
    return null;
  }

  /** 多入汇聚：收集引脚上全部连线的值，实体集展开为单实体（路径点等） */
  function evalDataInputs(nodeId: string, portId: string): DataValue[] {
    const out: DataValue[] = [];
    for (const e of graph.edges) {
      if (e.dstNode !== nodeId || e.dstPort !== portId) continue;
      const v = evalDataOutput(e.srcNode, e.srcPort);
      if (Array.isArray(v)) out.push(...v);
      else if (v !== null && v !== undefined) out.push(v);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // exec 链邻接：node.id → portId → 下游 exec 目标（含目标入端口类型）
  // 支持多 exec 出端口（next/true/false/loop/completed）；容器的 event 入端口
  // （dstPort === "event"）也纳入邻接：进入容器时以「源端口名 / 源 params.event」
  // 作为事件名做状态切换
  // ---------------------------------------------------------------------------
  const execOut = new Map<string, Map<string, { id: string; dstPort: string }[]>>();
  for (const e of graph.edges) {
    if (e.dstPort !== "exec" && e.dstPort !== "event") continue;
    const portMap = execOut.get(e.srcNode) ?? new Map<string, { id: string; dstPort: string }[]>();
    const list = portMap.get(e.srcPort) ?? [];
    list.push({ id: e.dstNode, dstPort: e.dstPort });
    portMap.set(e.srcPort, list);
    execOut.set(e.srcNode, portMap);
  }
  function execNextOf(nodeId: string, port = "next"): string[] {
    return (execOut.get(nodeId)?.get(port) ?? []).map((t) => t.id);
  }
  function execTargetsOf(nodeId: string, port = "next"): { id: string; dstPort: string }[] {
    return execOut.get(nodeId)?.get(port) ?? [];
  }

  /** 节点是否有 exec 入边（有 = 由事件链驱动；无 = 旧式 trigger 驱动） */
  const hasExecInput = new Set<string>();
  for (const e of graph.edges) {
    if (e.dstPort === "exec") hasExecInput.add(e.dstNode);
  }

  // ---------------------------------------------------------------------------
  // 容器：归属链与激活判定（容器行为 childActive 逐层判定，kernel 不含状态机语义）
  // ---------------------------------------------------------------------------

  function containerChildren(containerId: string): GNode[] {
    return graph.nodes
      .filter((n) => n.containerId === containerId)
      .sort((a, b) => a.y - b.y || a.x - b.x);
  }

  /** 节点在归属容器链上是否处于激活态 */
  function nodeActive(node: GNode): boolean {
    if (!node.containerId) return true;
    return activeIn(node.containerId, node, new Set<string>());
  }
  function activeIn(containerId: string, child: GNode, guard: Set<string>): boolean {
    if (guard.has(containerId)) return true;
    guard.add(containerId);
    const c = nodeOf(containerId);
    if (!c) return true;
    const beh = containers[c.type];
    if (beh?.childActive && beh.childActive(kernel, c, child) === false) return false;
    if (!c.containerId) return true;
    return activeIn(c.containerId, c, guard);
  }

  // ---------------------------------------------------------------------------
  // 驱动器：实例缓存（frameOps / 容器步进共享同一实例的跨帧状态）
  // ---------------------------------------------------------------------------

  const driverInsts = new Map<string, DriverInstance>();
  function driverInst(node: GNode): DriverInstance | null {
    const factory = drivers[node.type];
    if (!factory) return null;
    let inst = driverInsts.get(node.id);
    if (!inst) {
      inst = factory(kernel, node);
      driverInsts.set(node.id, inst);
    }
    return inst;
  }
  function stepDriver(node: GNode, dt: number, targets?: NodeObj[]): void {
    const inst = driverInst(node);
    if (!inst) return;
    const ts = targets ?? resolveTargets(node.id);
    if (!ts.length) return;
    inst.boot?.(ts);
    inst.step(dt, ts);
  }

  // ---------------------------------------------------------------------------
  // exec 链级联派发
  // ---------------------------------------------------------------------------

  function cascadeNext(node: GNode, ec: ExecCtx, port = "next", eventName?: string): void {
    for (const t of execTargetsOf(node.id, port)) {
      cascadeExec(t.id, ec.seen, port, t.dstPort, eventName ?? ec.fireEv);
    }
  }

  /**
   * exec 链级联：容器 → 执行链执行器 → 驱动器（透传）→ op → 停。
   * 事件名传递语义与旧实现一致：本节点 params.event 优先，否则沿用触发方。
   */
  function cascadeExec(
    opId: string,
    seen: Set<string> = new Set(),
    viaSrcPort = "next",
    viaDstPort = "exec",
    eventName = EMPTY_EVENT,
  ): void {
    if (seen.has(opId)) return;
    seen.add(opId);
    const node = nodeOf(opId);
    if (!node || node.unresolved) return;
    const fireEv = strP(node, "event", "") || eventName || viaSrcPort;
    const ec: ExecCtx = { seen, viaSrcPort, viaDstPort, eventName, fireEv };
    // 容器（能力 container）：进入/事件切换由容器行为实现
    const beh = containers[node.type];
    if (beh && hasNodeTypeCapability(node.type, "container")) {
      beh.enter(kernel, node, ec);
      return;
    }
    // 执行链节点（var.set/flow.*：路由型，自带级联）
    const chain = executors[node.type];
    if (chain) {
      chain(kernel, node, ec);
      return;
    }
    // 驱动器：exec 链不直接步进（frame 循环/容器驱动），链路透传下游
    if (drivers[node.type]) {
      cascadeNext(node, ec);
      return;
    }
    // op：一次性执行（容器内子节点仅在所属状态激活时执行）
    const executor = ops[node.type];
    if (executor && hasNodeTypeCapability(node.type, "op")) {
      if (!nodeActive(node)) return;
      executor(kernel, node, resolveTargets(opId));
      cascadeNext(node, ec);
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // kernel 服务面（handler 消费；必须先于装配构造——事件绑定/点击收集会调用
  // resolver/evalData，其签名以 kernel 为第一参数）
  // ---------------------------------------------------------------------------
  const kernel: GraphKernel = {
    graph,
    nodeOf,
    sceneById: byId,
    sceneAll: all,
    logicApi,
    navApi,
    numP,
    strP,
    boolP,
    resolveSet,
    resolveTargets,
    evalOutput: evalDataOutput,
    evalInput: evalDataInput,
    evalInputs: evalDataInputs,
    cascade: (nodeId, ec) =>
      cascadeExec(nodeId, ec?.seen ?? new Set(), ec?.viaSrcPort ?? "next", ec?.viaDstPort ?? "exec", ec?.eventName ?? EMPTY_EVENT),
    cascadeNext,
    execTargetsOf,
    execNextOf,
    varGet: (varId) => varStore.get(varId) ?? null,
    varSet: (varId, v) => varStore.set(varId, v),
    loopIndex: (id) => loopIndex.get(id),
    setLoopIndex: (id, i) => loopIndex.set(id, i),
    clearLoopIndex: (id) => loopIndex.delete(id),
    loopItem: (id) => loopItem.get(id),
    setLoopItem: (id, item) => loopItem.set(id, item),
    containerChildren,
    nodeActive,
    stepDriver,
    inFrameLoop: (nodeId) => frameOpsNodes.has(nodeId),
    warnOnce,
    elapsed: () => elapsed,
  };

  // ---------------------------------------------------------------------------
  // 装配：事件入口（eventEntry 能力 + trigger 绑定）、旧式 trigger 兼容、点击射线
  // 容器内子节点（containerId 非空）不参与全局事件驱动，只由容器驱动
  // ---------------------------------------------------------------------------

  const eventNodes = graph.nodes.filter(
    (n) => !n.containerId && !n.unresolved && hasNodeTypeCapability(n.type, "eventEntry"),
  );
  const triggerOf = (n: GNode): "start" | "frame" | "click" | undefined => typeDefOf(n)?.trigger;
  const startEvents = eventNodes.filter((n) => triggerOf(n) === "start");
  const tickEvents = eventNodes.filter((n) => triggerOf(n) === "frame");
  const clickEvents = eventNodes.filter((n) => triggerOf(n) === "click");

  // ----- 旧式操作（有 op/driver 能力、无 exec 入边：按类型 trigger 独立执行） -----
  const legacyOps = graph.nodes.filter(
    (n) =>
      !n.containerId &&
      !n.unresolved &&
      !hasExecInput.has(n.id) &&
      (hasNodeTypeCapability(n.type, "op") || hasNodeTypeCapability(n.type, "driver")),
  );
  const legacyStartOps = legacyOps.filter((n) => triggerOf(n) === "start");
  const legacyFrameOps = legacyOps.filter((n) => triggerOf(n) === "frame");
  const legacyClickOps = legacyOps.filter((n) => triggerOf(n) === "click");

  // ----- tick 链：每帧级联入口 + 驱动器发现 -----
  const tickChainEntries: string[] = [];
  const tickChainDrivers: GNode[] = [];
  for (const ev of tickEvents) {
    const next = execNextOf(ev.id);
    for (const id of next) {
      tickChainEntries.push(id);
      collectFrameOps(id, new Set());
    }
  }
  function collectFrameOps(opId: string, seen: Set<string>): void {
    if (seen.has(opId)) return;
    seen.add(opId);
    const op = nodeOf(opId);
    if (!op || op.unresolved) return;
    if (drivers[op.type]) tickChainDrivers.push(op);
    // 遍历所有 exec 出端口（next/true/false/loop/completed/event）
    const portMap = execOut.get(opId);
    if (portMap) for (const [, targets] of portMap) for (const t of targets) collectFrameOps(t.id, seen);
  }

  // ----- frame：逐帧行为装配（旧式 frame 驱动 + tick 链驱动） -----
  // 注意：装配与驱动器基准捕获必须发生在 start 链执行之后（旧时序如此：
  // bob/patrol 的基准位以 start 属性设置落位后的位置为准）
  const frameOps: { node: GNode; targets: NodeObj[] }[] = [];
  const frameOpsNodes = new Set<string>(); // 已被 frameOps 步进的驱动器（容器 frame 钩子去重）
  function assembleFrameOps(): void {
    for (const op of [...legacyFrameOps, ...tickChainDrivers]) {
      const targets = resolveTargets(op.id);
      if (!targets.length) {
        // 帧驱动无目标 = 装配即被跳过（运行期不再有任何动作）。
        // 接错端口（把被移动实体接到「路径点」）与实体缺失都落在这里，必须可见
        const label = nodeTypeDef(op.type)?.label ?? op.type;
        warnOnce(
          `driver-no-target:${op.id}`,
          `[graph] 驱动器「${label}」(${op.type}, 节点 ${op.id}) 无目标实体，已跳过——请检查「目标」口连线，以及被连实体是否存在（路径点口只接路径点，被移动对象要接目标口）`,
        );
        continue;
      }
      frameOps.push({ node: op, targets });
      frameOpsNodes.add(op.id);
      driverInst(op)?.boot?.(targets);
      // 目标解析结果（预览调试：确认被驱动的是哪个实体，重名/看错对象一眼可辨）
      postLog("info",
        `[graph] 帧驱动器「${nodeTypeDef(op.type)?.label ?? op.type}」(${op.id}) → 目标实体 [${targets.map((t) => t.id).join(", ")}]`,
      );
    }
  }

  // ----- click：指针射线命中（事件入口链 + 旧式 click op） -----
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  /** 事件驱动：onClick 命中后级联整条 exec 链（含 flow、var.set 等控制流） */
  const onClickCascades: { ev: GNode; targets: NodeObj[] }[] = [];
  /** 显式点击执行项（直接子 op / 旧式 op）：命中实体为唯一目标执行 */
  const allClickOps: { node: GNode; targets: NodeObj[] }[] = [];
  for (const ev of clickEvents) {
    const targets = resolveTargets(ev.id);
    const next = execNextOf(ev.id);
    if (next.length && targets.length) {
      onClickCascades.push({ ev, targets });
      // 仍收集直接子节点用于射线检测目标集
      for (const id of next) {
        const op = nodeOf(id);
        if (op) allClickOps.push({ node: op, targets });
      }
    }
  }
  for (const op of legacyClickOps) {
    const targets = resolveTargets(op.id);
    if (targets.length) allClickOps.push({ node: op, targets });
  }

  function onPointerDown(e: PointerEvent): void {
    if (!allClickOps.length && !onClickCascades.length) return;
    const rect = dom.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    // 收集所有 click 目标对象做一次射线检测
    const allTargets = new Map<string, NodeObj>();
    for (const entry of allClickOps) {
      for (const t of entry.targets) allTargets.set(t.id, t);
    }
    for (const oc of onClickCascades) {
      for (const t of oc.targets) allTargets.set(t.id, t);
    }
    const hits = raycaster.intersectObjects([...allTargets.values()].map((t) => t.obj), true);
    // 命中对象可能是不带标记的内部子对象：向上找最近的带标记节点
    const hitId = (() => {
      for (const h of hits) {
        let o: THREE.Object3D | null = h.object;
        while (o) {
          const id = typeof o.userData?.nodeId === "string" ? o.userData.nodeId : "";
          if (id && allTargets.has(id)) return id;
          o = o.parent;
        }
      }
      return "";
    })();
    if (!hitId) return;

    // 显式项：trigger=click 的 op 以命中实体为唯一目标执行（与旧实现一致）
    for (const entry of allClickOps) {
      if (!entry.targets.some((t) => t.id === hitId)) continue;
      if (triggerOf(entry.node) !== "click") continue;
      const ex = ops[entry.node.type];
      const hit = byId.get(hitId);
      if (ex && hit) ex(kernel, entry.node, [hit]);
    }
    // 事件驱动：onClick 命中后级联整条 exec 链
    for (const oc of onClickCascades) {
      if (!oc.targets.some((t) => t.id === hitId)) continue;
      for (const id of execNextOf(oc.ev.id)) cascadeExec(id);
    }
  }
  if (allClickOps.length || onClickCascades.length) dom.addEventListener("pointerdown", onPointerDown);

  // ---------------------------------------------------------------------------
  // 装配期契约校验：注册表能力 ↔ handler 表对齐（缺语义告警，不 crash）
  // ---------------------------------------------------------------------------
  {
    const warned = new Set<string>();
    for (const n of graph.nodes) {
      if (n.unresolved) {
        if (!warned.has(n.type)) {
          warned.add(n.type);
          postLog("warn", `[graph] 节点类型 "${n.type}" 的模块未装载，已跳过执行`);
        }
        continue;
      }
      const isOpCap = hasNodeTypeCapability(n.type, "op") || hasNodeTypeCapability(n.type, "driver");
      if (isOpCap && !ops[n.type] && !drivers[n.type] && !warned.has(n.type)) {
        warned.add(n.type);
        postLog("warn", `[graph] 类型 "${n.type}" 声明 op/driver 能力但运行时缺少 handler`);
      }
      if (hasNodeTypeCapability(n.type, "container") && !containers[n.type] && !warned.has(n.type)) {
        warned.add(n.type);
        postLog("warn", `[graph] 容器类型 "${n.type}" 缺少运行时容器行为`);
      }
      if (hasNodeTypeCapability(n.type, "entitySource") && !resolvers[n.type] && !warned.has(n.type)) {
        warned.add(n.type);
        postLog("warn", `[graph] 实体集源类型 "${n.type}" 缺少解析器`);
      }
    }
  }

  // ----- start：装配即执行一次（事件链 + 旧式 trigger=start）-----
  // 时序：kernel 服务面就绪后执行；驱动器基准捕获（assembleFrameOps）
  // 在 start 之后，保证 bob/patrol 基准位取属性落位后的位置
  for (const ev of startEvents) {
    const next = execNextOf(ev.id);
    if (next) for (const id of next) cascadeExec(id);
  }
  for (const op of legacyStartOps) {
    const ex = ops[op.type];
    if (!ex) continue;
    const targets = resolveTargets(op.id);
    if (targets.length) ex(kernel, op, targets);
  }
  assembleFrameOps();

  // 装配摘要（预览控制台回传编辑器：用于确认"图是否被装载、装载了什么"）
  postLog("info",
    `[graph] 场景图行为已装配：节点 ${graph.nodes.length}，tick 链 ${tickChainEntries.length}，` +
      `帧驱动器 ${frameOps.length}，点击行为 ${allClickOps.length}，容器帧驱动 ${graph.nodes.filter((n) => containers[n.type]).length}`,
  );

  return {
    update(dt: number) {
      elapsed += dt;
      sampleTimer += dt;
      // 容器每帧驱动（状态轮询、激活态子驱动步进等，语义在容器行为模块内）
      const framed = new Set<ContainerBehavior>();
      for (const n of graph.nodes) {
        if (n.unresolved) continue;
        const beh = containers[n.type];
        if (beh?.frame && hasNodeTypeCapability(n.type, "container")) {
          beh.frame(kernel, n, dt);
          framed.add(beh);
        }
      }
      // 全部容器帧后聚合钩子（每个行为实例一次：跨容器状态 flush）
      for (const beh of framed) beh.frameEnd?.(kernel, dt);
      // tick 链每帧级联（var.set/flow.* 等；驱动器由 frameOps 步进）
      for (const entryId of tickChainEntries) {
        cascadeExec(entryId);
      }
      for (const behavior of frameOps) {
        // 容器内帧行为：所属状态未激活时暂停（激活恢复后从基准位继续）
        if (!nodeActive(behavior.node)) continue;
        const inst = driverInst(behavior.node);
        inst?.step(dt, behavior.targets);
      }
      // 帧驱动采样（诊断：每个驱动器每秒采一次目标世界位置，2 次后停止）。
      // 两次采样位移为 0 = 驱动器/参数层面无动作；有位移 = 内核已在移动该实体，
      // "看着不动"需核对采样里的实体名称是否就是被观察的对象
      if (frameOps.length && sampleTimer >= 1) {
        sampleTimer -= 1;
        for (const b of frameOps) {
          const n = sampleCounts.get(b.node.id) ?? 0;
          if (n >= SAMPLE_LIMIT) continue;
          sampleCounts.set(b.node.id, n + 1);
          const t = b.targets[0];
          if (!t) continue;
          t.obj.getWorldPosition(sampleVector);
          postLog("info",
            `[graph] 帧驱动采样「${nodeTypeDef(b.node.type)?.label ?? b.node.type}」(${b.node.id}) ` +
              `目标 ${t.id}（名称 ${t.obj.name}）世界位置 (${sampleVector.x.toFixed(2)}, ${sampleVector.y.toFixed(2)}, ${sampleVector.z.toFixed(2)}) ` +
              `参数 ${JSON.stringify(b.node.params ?? {})}`,
          );
        }
      }
    },
    dispose() {
      dom.removeEventListener("pointerdown", onPointerDown);
      for (const m of modules) m.dispose?.();
    },
  };
}
