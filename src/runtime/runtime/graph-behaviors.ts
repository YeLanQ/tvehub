// ---------------------------------------------------------------------------
// 场景图行为解释器（预览/发布运行时）：解释场景图文档，
// 把图上对原型定义的操作作为运行时行为执行 —— 不修改场景数据，只在运行期
// 改变实体的表现（与脚本语义一致：位姿/可见性/状态机事件）。
//
// 执行模型（蓝图式 exec 链级联 + 拉模型数据流）：
// - 事件节点（event.onBegin/onTick/onClick）是执行链入口，有 next（exec 出端口）；
// - 操作节点有 exec（exec 入端口）+ next（exec 出端口）；
// - var.set 节点在 exec 链中执行：从 value 入引脚拉取数据 → 写入图变量 → 级联 next；
// - var.get 节点是纯数据节点：输出引脚被拉取时读图变量当前值；
// - 事件触发时沿 next → exec 级联执行下游操作链；
// - 向后兼容：无 exec 入边的旧操作按 trigger 字段独立执行（无事件节点驱动的旧图）。
//
// 逻辑容器（多会话场景图：fsm.container / bt.container，可嵌套）：
// - 容器内节点以 containerId 归属容器，不参与全局事件驱动，只由容器驱动；
// - fsm.container：params.states（逗号分隔）声明状态、params.initial 初始状态。
//   exec 入「进入」→ 激活 initial；「event」入端口 → 事件切换状态（事件名取
//   源节点 params.event，缺省用源 exec 出端口名，如 branch 的 true/false）。
//   进入状态 = 执行 containerId 归属且 stateName 匹配（无标签则任意状态）的
//   直接子节点链，随后级联容器 next 下游；
// - bt.container：exec 入「进入」→ 按子节点纵向排序依次执行归属节点链
//   （顺序节点语义），完成后级联容器 next 下游；
// - 嵌套：容器也是节点，作为其父容器的子节点递归进入/执行；fsm 子节点
//   （含嵌套容器）仅在所属状态激活时执行（nodeActive 沿归属链逐层判定）。
//
// 目标解析（实体集通道，独立于 exec 链）：
// - proto：按场景节点 id 精确匹配；match：按标签/类型批量匹配；
// - op.out 实体透传 → 上游递归。
//
// 数据流求值（拉模型）：
// - evalDataInput(nodeId, portId)：沿边回溯到源节点输出引脚 → evalDataOutput；
// - evalDataOutput(nodeId, portId)：按节点类型求值（var.get 读变量 / 后续 math/flow 节点）；
// - 标量值（number/boolean/string）经数据引脚流动，exec 链节点按需拉取。
// ---------------------------------------------------------------------------

import * as THREE from "three";
import type { GNode, GCustomNodeDef, ScriptGraphDoc } from "../../framework/graph";

/** 场景节点对象（buildSceneTree 打 userData.nodeId/nodeKind/nodeTag 标记） */
interface NodeObj {
  obj: THREE.Object3D;
  id: string;
  kind: string;
  tag: string;
}

/** 数据引脚运行时值（标量 / vec3 / 实体集 / null=未连接） */
type DataValue = number | boolean | string | { x: number; y: number; z: number } | NodeObj[] | null;

/** 数值提取（DataValue → number，非数值回退 0） */
function toNum(v: DataValue): number {
  return typeof v === "number" ? v : 0;
}
/** 字符串提取（DataValue → string） */
function toStr(v: DataValue): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return String(v);
  return "";
}

export interface GraphBehaviorsCtx {
  scene: THREE.Scene;
  dom: HTMLElement;
  camera: THREE.Camera;
  logicApi: {
    fire(entity: { id: string }, event: string): void;
    setParam(entity: { id: string }, key: string, value: number): void;
  };
  graph: ScriptGraphDoc;
  /** 导航运行时（可选）：追击类驱动器借此暂停/恢复目标的导航巡回 */
  navApi?: { setAgentPaused(id: string, paused: boolean): void };
}

export interface GraphBehaviorsHandle {
  update(dt: number): void;
  dispose(): void;
}

/** 属性路径写入（Entity 暴露的分量：position/rotation/scale 各分量 + visible） */
function setPath(obj: THREE.Object3D, path: string, value: number): boolean {
  switch (path) {
    case "position.x": obj.position.x = value; return true;
    case "position.y": obj.position.y = value; return true;
    case "position.z": obj.position.z = value; return true;
    case "rotation.x": obj.rotation.x = (value * Math.PI) / 180; return true;
    case "rotation.y": obj.rotation.y = (value * Math.PI) / 180; return true;
    case "rotation.z": obj.rotation.z = (value * Math.PI) / 180; return true;
    case "scale.x": obj.scale.x = value; return true;
    case "scale.y": obj.scale.y = value; return true;
    case "scale.z": obj.scale.z = value; return true;
    default: return false;
  }
}

/** 灯光分量路径写入（light 组件：强度/距离/聚光角；对象树内找首个光源） */
function setLightPath(obj: THREE.Object3D, path: string, value: number): boolean {
  if (!path.startsWith("light.")) return false;
  let light: THREE.Light | null = null;
  obj.traverse((o) => {
    if (!light && (o as THREE.Light).isLight === true) light = o as THREE.Light;
  });
  if (!light) return false;
  switch (path) {
    case "light.intensity": light.intensity = value; return true;
    case "light.distance": (light as THREE.PointLight).distance = value; return true;
    case "light.angle": (light as THREE.SpotLight).angle = value * DEG; return true;
    default: return false;
  }
}

const DEG = Math.PI / 180;

export function createGraphBehaviors(ctx: GraphBehaviorsCtx): GraphBehaviorsHandle {
  const { scene, dom, camera, logicApi, graph, navApi } = ctx;

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

  /** 匹配节点/原型的实体集 */
  function resolveSet(refId: string, seen = new Set<string>()): NodeObj[] {
    if (seen.has(refId)) return [];
    seen.add(refId);
    const node = nodeOf(refId);
    if (!node) return [];
    // 逻辑容器：输出 = 自身作用域入端口的实体集（上游递归）
    if (node.type === "fsm.container" || node.type === "bt.container") {
      return resolveTargets(refId);
    }
    if (node.type === "entity.proto") {
      const hit = byId.get(node.entityId ?? "");
      return hit ? [hit] : [];
    }
    if (node.type === "entity.match") {
      const p = node.matchPattern ?? "";
      if (!p) return [];
      return all.filter((n) => (node.matchMode === "type" ? n.kind === p : n.tag === p));
    }
    return [];
  }

  /** 操作的目标集：实体集通道上游（op.out 实体透传 → 递归上游） */
  function resolveTargets(opId: string, seen = new Set<string>()): NodeObj[] {
    if (seen.has(opId)) return [];
    seen.add(opId);
    const out: NodeObj[] = [];
    for (const e of graph.edges) {
      if (e.dstNode !== opId || e.dstPort !== "in") continue;
      const src = nodeOf(e.srcNode);
      if (!src) continue;
      if (src.type.startsWith("op.")) out.push(...resolveTargets(src.id, seen));
      else out.push(...resolveSet(src.id));
    }
    return out;
  }

  // ----- 图变量存储（运行时值；从 doc.variables 初始化） -----
  const varStore = new Map<string, DataValue>();
  for (const v of graph.variables ?? []) varStore.set(v.id, v.value);

  // ----- 循环上下文：For/ForEach 当前迭代值 -----
  const loopIndex = new Map<string, number>(); // flow.for node.id → 当前 index
  const loopItem = new Map<string, NodeObj | null>(); // flow.forEach node.id → 当前 item

  // ----- 自定义节点表达式编译缓存 -----
  interface CompiledExpr { fn: (...args: unknown[]) => unknown; inputIds: string[]; fieldKeys: string[]; }
  const customExprCache = new Map<string, CompiledExpr | null>();
  for (const def of graph.customNodes ?? []) {
    for (const out of def.outputs ?? []) {
      const expr = def.expressions?.[out.id];
      if (!expr) { customExprCache.set(`${def.type}\u0000${out.id}`, null); continue; }
      const inputIds = (def.inputs ?? []).map((p) => p.id);
      const fieldKeys = (def.fields ?? []).map((f) => f.key);
      try {
        const fn = new Function(...inputIds, ...fieldKeys, "Math", `"use strict"; return (${expr});`) as (...args: unknown[]) => unknown;
        customExprCache.set(`${def.type}\u0000${out.id}`, { fn, inputIds, fieldKeys });
      } catch {
        customExprCache.set(`${def.type}\u0000${out.id}`, null);
      }
    }
  }
  /** 自定义节点定义查找 */
  const customDefMap = new Map<string, GCustomNodeDef>();
  for (const d of graph.customNodes ?? []) customDefMap.set(d.type, d);

  /** 数据流求值：节点输出引脚的值（拉模型） */
  function evalDataOutput(nodeId: string, portId: string, seen = new Set<string>()): DataValue {
    if (seen.has(`${nodeId}\u0000${portId}`)) return null; // 环防护
    seen.add(`${nodeId}\u0000${portId}`);
    const node = nodeOf(nodeId);
    if (!node) return null;
    // var.get：读图变量当前值
    if (node.type === "var.get" && portId === "value") {
      return varStore.get(node.varId ?? "") ?? null;
    }
    // var.set：输出 = 已写入的值（exec 链执行时写入 varStore，此处读回）
    if (node.type === "var.set" && portId === "value") {
      return varStore.get(node.varId ?? "") ?? null;
    }
    // flow.compare：求值 a op b → boolean（B 引脚未连线时回退 params.b 参数值）
    if (node.type === "flow.compare" && portId === "result") {
      const a = evalDataInput(nodeId, "a");
      const bRaw = evalDataInput(nodeId, "b");
      const b = bRaw === null ? (typeof node.params?.b === "number" ? node.params.b : 0) : bRaw;
      const op = strP(node, "operator", ">");
      const an = typeof a === "number" ? a : 0;
      const bn = typeof b === "number" ? b : 0;
      switch (op) {
        case ">": return an > bn;
        case "<": return an < bn;
        case "==": return an === bn;
        case ">=": return an >= bn;
        case "<=": return an <= bn;
        case "!=": return an !== bn;
        default: return false;
      }
    }
    // flow.for：当前迭代索引
    if (node.type === "flow.for" && portId === "index") {
      return loopIndex.get(nodeId) ?? 0;
    }
    // flow.forEach：当前迭代实体
    if (node.type === "flow.forEach" && portId === "item") {
      const item = loopItem.get(nodeId);
      return item ? [item] : null;
    }
    // ----- 数学/工具/感知节点（纯数据求值） -----
    if (node.type.startsWith("math.") || node.type === "sense.distance") {
      return evalMath(node, nodeId, portId);
    }
    // ----- 自定义节点（表达式求值） -----
    if (node.type.startsWith("custom.")) {
      const compiled = customExprCache.get(`${node.type}\u0000${portId}`);
      if (!compiled) return null;
      const args: unknown[] = [];
      for (const id of compiled.inputIds) args.push(evalDataInput(nodeId, id));
      for (const key of compiled.fieldKeys) {
        const def = customDefMap.get(node.type);
        const f = def?.fields?.find((x) => x.key === key);
        const v = node.params?.[key];
        if (f?.kind === "number") args.push(typeof v === "number" ? v : (f.fallback as number));
        else if (f?.kind === "boolean") args.push(v === true);
        else args.push(typeof v === "string" ? v : (f?.fallback as string ?? ""));
      }
      args.push(Math);
      try {
        return compiled.fn(...args) as DataValue;
      } catch {
        return null;
      }
    }
    // entity.proto / entity.match：实体集作为数据值
    if (portId === "out") {
      return resolveSet(nodeId);
    }
    return null;
  }

  /** 数据流求值：节点输入引脚的值（沿边回溯到源输出 → 求值） */
  function evalDataInput(nodeId: string, portId: string): DataValue {
    for (const e of graph.edges) {
      if (e.dstNode !== nodeId || e.dstPort !== portId) continue;
      return evalDataOutput(e.srcNode, e.srcPort);
    }
    return null;
  }

  /** 数据流求值（多入汇聚）：收集引脚上全部连线的值，实体集展开为单实体（路径点等） */
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

  /** 数学/工具节点求值（纯数据，按 node.type 分支） */
  function evalMath(node: GNode, nodeId: string, portId: string): DataValue {
    const a = (): number => toNum(evalDataInput(nodeId, "a"));
    const b = (): number => toNum(evalDataInput(nodeId, "b"));
    switch (node.type) {
      case "math.add": return a() + b();
      case "math.sub": return a() - b();
      case "math.mul": return a() * b();
      case "math.div": { const bv = b(); return bv === 0 ? 0 : a() / bv; }
      case "math.mod": { const bv = b(); return bv === 0 ? 0 : a() % bv; }
      case "math.sin": return Math.sin(a() * DEG);
      case "math.cos": return Math.cos(a() * DEG);
      case "math.tan": return Math.tan(a() * DEG);
      case "math.vec3Make":
        if (portId === "v") return { x: toNum(evalDataInput(nodeId, "x")), y: toNum(evalDataInput(nodeId, "y")), z: toNum(evalDataInput(nodeId, "z")) };
        return null;
      case "math.vec3Break": {
        const v = evalDataInput(nodeId, "v");
        const vec = (v && typeof v === "object" && "x" in v && "y" in v && "z" in v) ? v as { x: number; y: number; z: number } : { x: 0, y: 0, z: 0 };
        if (portId === "x") return vec.x;
        if (portId === "y") return vec.y;
        if (portId === "z") return vec.z;
        return null;
      }
      case "math.stringConcat": return toStr(evalDataInput(nodeId, "a")) + toStr(evalDataInput(nodeId, "b"));
      case "math.toString": return toStr(evalDataInput(nodeId, "value"));
      case "math.lerp": { const av = a(), bv = b(), t = toNum(evalDataInput(nodeId, "t")); return av + (bv - av) * t; }
      case "math.clamp": {
        const val = toNum(evalDataInput(nodeId, "value")), mn = toNum(evalDataInput(nodeId, "min")), mx = toNum(evalDataInput(nodeId, "max"));
        return Math.max(mn, Math.min(mx, val));
      }
      case "math.abs": return Math.abs(a());
      // 感知：两实体世界距离（原型卡接线后每帧拉取求值）
      case "sense.distance": {
        const unwrap = (v: DataValue): NodeObj | null => {
          if (Array.isArray(v)) return v[0] ?? null;
          return v && typeof v === "object" && "obj" in v ? (v as NodeObj) : null;
        };
        const from = unwrap(evalDataInput(nodeId, "from"));
        const to = unwrap(evalDataInput(nodeId, "to"));
        if (!from || !to) return 0;
        return Math.hypot(
          from.obj.position.x - to.obj.position.x,
          from.obj.position.y - to.obj.position.y,
          from.obj.position.z - to.obj.position.z,
        );
      }
      default: return null;
    }
  }

  /** 参数读取（缺省回退：解析容错） */
  const numP = (n: GNode, key: string, fb = 0): number => {
    const v = n.params?.[key];
    return typeof v === "number" && Number.isFinite(v) ? v : fb;
  };
  const strP = (n: GNode, key: string, fb = ""): string => {
    const v = n.params?.[key];
    return typeof v === "string" ? v : fb;
  };

  // ----- exec 链邻接：node.id → portId → 下游 exec 目标（含目标入端口类型） -----
  // 支持多 exec 出端口（next/true/false/loop/completed）；容器的 event 入端口
  // （dstPort === "event"）也纳入邻接：进入容器时以「源端口名 / 源 params.event」
  // 作为事件名做状态切换
  const execOut = new Map<string, Map<string, { id: string; dstPort: string }[]>>();
  for (const e of graph.edges) {
    if (e.dstPort !== "exec" && e.dstPort !== "event") continue;
    const portMap = execOut.get(e.srcNode) ?? new Map<string, { id: string; dstPort: string }[]>();
    const list = portMap.get(e.srcPort) ?? [];
    list.push({ id: e.dstNode, dstPort: e.dstPort });
    portMap.set(e.srcPort, list);
    execOut.set(e.srcNode, portMap);
  }
  /** 取节点某 exec 出端口的下游 ids */
  function execNextOf(nodeId: string, port = "next"): string[] {
    return (execOut.get(nodeId)?.get(port) ?? []).map((t) => t.id);
  }
  /** 取节点某 exec 出端口的下游目标（含目标入端口类型，容器语义用） */
  function execTargetsOf(nodeId: string, port = "next"): { id: string; dstPort: string }[] {
    return execOut.get(nodeId)?.get(port) ?? [];
  }

  /** 节点是否有 exec 入边（有 = 由事件链驱动；无 = 旧式 trigger 驱动） */
  const hasExecInput = new Set<string>();
  for (const e of graph.edges) {
    if (e.dstPort === "exec") hasExecInput.add(e.dstNode);
  }

  // ----- 操作执行 -----
  const baseYMap = new Map<string, number>();

  /** 执行单个操作节点对目标集的行为 */
  function executeOp(op: GNode, targets: NodeObj[]): void {
    if (!targets.length) return;
    switch (op.opType ?? op.type) {
      case "op.set": {
        const path = strP(op, "property");
        const value = numP(op, "value");
        for (const t of targets) {
          if (!setPath(t.obj, path, value)) setLightPath(t.obj, path, value);
        }
        break;
      }
      case "op.setFsmParam":
        for (const t of targets) {
          try { logicApi.setParam({ id: t.id }, strP(op, "param"), numP(op, "value")); } catch { /* 跳过 */ }
        }
        break;
      case "op.toggleVisible":
        for (const t of targets) t.obj.visible = !t.obj.visible;
        break;
      case "op.fireFsm":
        for (const t of targets) {
          try { logicApi.fire({ id: t.id }, strP(op, "event")); } catch { /* 跳过 */ }
        }
        break;
      // op.spin / op.bob 由 frame 循环单独处理（需 dt + 基准位置）
    }
  }

  // ----- 容器（fsm.container / bt.container）运行时状态 -----
  /** FSM 容器当前状态（containerId → 状态名；未激活无键） */
  const fsmCurrent = new Map<string, string>();
  /** 容器直接子节点（containerId 归属，按纵向排序：BT 顺序语义用） */
  function containerChildren(containerId: string): GNode[] {
    return graph.nodes
      .filter((n) => n.containerId === containerId)
      .sort((a, b) => a.y - b.y || a.x - b.x);
  }
  /** 节点在归属容器链上是否处于激活态（FSM 层：stateName 匹配当前状态；BT 层恒激活） */
  function nodeActive(node: GNode): boolean {
    if (!node.containerId) return true;
    return activeIn(node.containerId, node, new Set<string>());
  }
  function activeIn(containerId: string, child: GNode, guard: Set<string>): boolean {
    if (guard.has(containerId)) return true;
    guard.add(containerId);
    const c = nodeOf(containerId);
    if (!c) return true;
    if (c.type === "fsm.container") {
      const cur = fsmCurrent.get(c.id);
      // FSM 未激活（无入边驱动的纯整理容器）视为全状态可用
      if (cur !== undefined && child.stateName && child.stateName !== cur) return false;
    }
    if (!c.containerId) return true;
    return activeIn(c.containerId, c, guard);
  }

  /**
   * 执行 FSM 容器：exec 入「进入」激活 initial；event 入「事件」按事件名切换
   * 状态（事件名 = 触发源 params.event 优先，缺省触发源 exec 出端口名）。
   * 激活状态 = 执行 containerId 归属且 stateName 匹配（无标签则任意状态）
   * 的直接子节点链，随后级联容器 next 下游。
   */
  function enterFsmContainer(node: GNode, seen: Set<string>, eventName: string, dstPort: string): void {
    const states = strP(node, "states")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!states.length) return;
    const initial = strP(node, "initial", states[0]) || states[0];
    let target: string;
    if (dstPort === "event") {
      if (!eventName || !states.includes(eventName)) return; // 非状态事件忽略
      target = eventName;
    } else {
      target = states.includes(initial) ? initial : states[0];
    }
    fsmCurrent.set(node.id, target);
    // 执行归属当前状态的直接子节点链（无状态标签的子节点任意状态都执行）
    for (const child of containerChildren(node.id)) {
      if (child.stateName && child.stateName !== target) continue;
      cascadeExec(child.id, new Set(), "next", "exec");
    }
    // 状态切换完成 → 容器 next 下游
    for (const t of execTargetsOf(node.id, "next")) cascadeExec(t.id, seen, "next", t.dstPort, eventName || target);
  }

  /** 执行 BT 容器：按子节点纵向排序依次执行，完成级联 next 下游 */
  function enterBtContainer(node: GNode, seen: Set<string>): void {
    for (const child of containerChildren(node.id)) {
      if (!nodeActive(child)) continue;
      cascadeExec(child.id, new Set(), "next", "exec");
    }
    for (const t of execTargetsOf(node.id, "next")) cascadeExec(t.id, seen, "next", t.dstPort);
  }

  /**
   * exec 链级联：执行 op、var.set、flow 与容器节点 → 沿 exec 出端口 → 下游。
   * eventName：触发方携带的事件名（源节点 params.event 优先，缺省源端口名），
   * 进入 fsm.container 的 event 入端口时用于状态切换。
   */
  function cascadeExec(
    opId: string,
    seen = new Set<string>(),
    viaSrcPort = "next",
    viaDstPort = "exec",
    eventName = "",
  ): void {
    if (seen.has(opId)) return;
    seen.add(opId);
    const node = nodeOf(opId);
    if (!node) return;
    // 下游传递的事件名：本节点 params.event 优先，否则沿用触发方事件名/端口名
    const fireEv = strP(node, "event", "") || eventName || viaSrcPort;
    // fsm.container：进入（exec）激活 initial；事件（event）按事件名切换状态
    if (node.type === "fsm.container") {
      enterFsmContainer(node, seen, eventName || viaSrcPort, viaDstPort);
      return;
    }
    // bt.container：进入 → 顺序执行归属子节点链
    if (node.type === "bt.container") {
      enterBtContainer(node, seen);
      return;
    }
    // var.set：从 value 入引脚拉取数据 → 写入图变量
    if (node.type === "var.set") {
      const val = evalDataInput(opId, "value");
      if (val !== null) varStore.set(node.varId ?? "", val);
      for (const t of execTargetsOf(opId, "next")) cascadeExec(t.id, seen, "next", t.dstPort, fireEv);
      return;
    }
    // flow.branch：条件选择 true/false 分支
    if (node.type === "flow.branch") {
      const cond = evalDataInput(opId, "condition") === true;
      const port = cond ? "true" : "false";
      for (const t of execTargetsOf(opId, port)) cascadeExec(t.id, seen, port, t.dstPort, fireEv || port);
      return;
    }
    // flow.compare：纯数据节点，exec 链中不执行（由 evalDataOutput 求值）
    if (node.type === "flow.compare") {
      for (const t of execTargetsOf(opId, "next")) cascadeExec(t.id, seen, "next", t.dstPort, fireEv);
      return;
    }
    // flow.for：计数循环
    if (node.type === "flow.for") {
      const start = numP(node, "start", 0);
      const end = numP(node, "end", 10);
      const step = numP(node, "step", 1);
      const loop = execTargetsOf(opId, "loop");
      const completed = execTargetsOf(opId, "completed");
      const maxIter = 100000;
      let iter = 0;
      for (let i = start; (step > 0 ? i < end : i > end) && iter < maxIter; i += step, iter++) {
        loopIndex.set(opId, i);
        for (const t of loop) cascadeExec(t.id, new Set(), "loop", t.dstPort, fireEv);
      }
      loopIndex.delete(opId);
      for (const t of completed) cascadeExec(t.id, seen, "completed", t.dstPort, fireEv);
      return;
    }
    // flow.forEach：实体集遍历
    if (node.type === "flow.forEach") {
      const arr = evalDataInput(opId, "array");
      const items = Array.isArray(arr) ? arr : [];
      const loop = execTargetsOf(opId, "loop");
      const completed = execTargetsOf(opId, "completed");
      for (const item of items) {
        loopItem.set(opId, item);
        for (const t of loop) cascadeExec(t.id, new Set(), "loop", t.dstPort, fireEv);
      }
      loopItem.delete(opId);
      for (const t of completed) cascadeExec(t.id, seen, "completed", t.dstPort, fireEv);
      return;
    }
    // flow.while：条件循环（最多 10000 次防死循环）
    if (node.type === "flow.while") {
      const loop = execTargetsOf(opId, "loop");
      const completed = execTargetsOf(opId, "completed");
      const maxIter = 10000;
      for (let i = 0; i < maxIter; i++) {
        if (evalDataInput(opId, "condition") !== true) break;
        for (const t of loop) cascadeExec(t.id, new Set(), "loop", t.dstPort, fireEv);
      }
      for (const t of completed) cascadeExec(t.id, seen, "completed", t.dstPort, fireEv);
      return;
    }
    // op.*：执行操作（容器内子节点仅在所属状态激活时执行）
    if (!node.type.startsWith("op.")) return;
    if (!nodeActive(node)) return;
    const targets = resolveTargets(opId);
    executeOp(node, targets);
    for (const t of execTargetsOf(opId, "next")) cascadeExec(t.id, seen, "next", t.dstPort, fireEv);
  }

  // ----- 事件节点 -----
  // 容器内子节点（containerId 非空）不参与全局事件驱动，只由容器驱动
  const eventNodes = graph.nodes.filter((n) => n.type.startsWith("event."));
  const onBeginNodes = eventNodes.filter((n) => n.type === "event.onBegin" && !n.containerId);
  const onTickNodes = eventNodes.filter((n) => n.type === "event.onTick" && !n.containerId);
  const onClickNodes = eventNodes.filter((n) => n.type === "event.onClick" && !n.containerId);

  // ----- 旧式操作（无 exec 入边，按 trigger 独立执行；向后兼容） -----
  const legacyOps = graph.nodes.filter(
    (n) => n.type.startsWith("op.") && !hasExecInput.has(n.id) && !n.containerId,
  );
  const legacyStartOps = legacyOps.filter((n) => (n.opType ?? n.type) === "op.set" || (n.opType ?? n.type) === "op.setFsmParam");
  const legacySpinOps = legacyOps.filter((n) => (n.opType ?? n.type) === "op.spin");
  const legacyBobOps = legacyOps.filter((n) => (n.opType ?? n.type) === "op.bob");
  const legacyClickOps = legacyOps.filter((n) => (n.opType ?? n.type) === "op.toggleVisible" || (n.opType ?? n.type) === "op.fireFsm");

  // ----- start：装配即执行一次 -----
  // 事件驱动：onBegin → cascade
  for (const ev of onBeginNodes) {
    const next = execNextOf(ev.id);
    if (next) for (const id of next) cascadeExec(id);
  }
  // 旧式：trigger=start 的 op 直接执行
  for (const op of legacyStartOps) {
    executeOp(op, resolveTargets(op.id));
  }

  // ----- frame：每帧行为 -----
  const frameOps: { node: GNode; targets: NodeObj[]; baseY: Map<string, number> }[] = [];
  // 事件驱动的 tick 链中 op.spin/op.bob/op.patrol/op.chase 需逐帧执行
  const tickChainOps: GNode[] = [];
  // tick 链入口节点（每帧级联执行 var.set/flow.* 等非位移节点）
  const tickChainEntries: string[] = [];
  for (const ev of onTickNodes) {
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
    if (!op) return;
    if (
      op.type === "op.spin" || op.type === "op.bob" ||
      op.type === "op.patrol" || op.type === "op.chase" || op.type === "op.navMove"
    ) tickChainOps.push(op);
    // 遍历所有 exec 出端口（next/true/false/loop/completed/event）
    const portMap = execOut.get(opId);
    if (portMap) for (const [, targets] of portMap) for (const t of targets) collectFrameOps(t.id, seen);
  }
  // 合并事件驱动 + 旧式 frame ops（含旧式无 exec 的巡逻/追击）
  const legacyFrameOps = legacyOps.filter(
    (n) => (n.opType ?? n.type) === "op.patrol" || (n.opType ?? n.type) === "op.chase" || (n.opType ?? n.type) === "op.navMove",
  );
  const allFrameOps = [...legacySpinOps, ...legacyBobOps, ...legacyFrameOps, ...tickChainOps];
  for (const op of allFrameOps) {
    const targets = resolveTargets(op.id);
    if (!targets.length) continue;
    const baseY = new Map<string, number>();
    for (const t of targets) baseY.set(t.id, t.obj.position.y);
    frameOps.push({ node: op, targets, baseY });
  }

  // ----- click：指针射线命中 -----
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  /** 事件驱动 + 旧式的所有 click 操作（合并检测） */
  const allClickOps: { node: GNode; targets: NodeObj[]; eventDriven: boolean }[] = [];
  // 事件驱动：onClick → cascade（需先检测命中再级联）
  const onClickCascades: { ev: GNode; targets: NodeObj[] }[] = [];
  for (const ev of onClickNodes) {
    const targets = resolveTargets(ev.id);
    const next = execNextOf(ev.id);
    if (next.length && targets.length) {
      onClickCascades.push({ ev, targets });
      // 仍收集直接子节点用于射线检测目标集
      for (const id of next) {
        const op = nodeOf(id);
        if (op) allClickOps.push({ node: op, targets, eventDriven: true });
      }
    }
  }
  // 旧式：trigger=click 的 op
  for (const op of legacyClickOps) {
    allClickOps.push({ node: op, targets: resolveTargets(op.id), eventDriven: false });
  }

  function onPointerDown(e: PointerEvent): void {
    if (!allClickOps.length) return;
    const rect = dom.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    // 收集所有 click op 的目标对象做一次射线检测
    const allTargets = new Map<string, NodeObj>();
    for (const entry of allClickOps) {
      for (const t of entry.targets) allTargets.set(t.id, t);
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

    for (const entry of allClickOps) {
      if (!entry.targets.some((t) => t.id === hitId)) continue;
      const op = entry.node;
      const opType = op.opType ?? op.type;
      if (opType === "op.toggleVisible") {
        const t = entry.targets.find((t) => t.id === hitId);
        if (t) t.obj.visible = !t.obj.visible;
      } else if (opType === "op.fireFsm") {
        try { logicApi.fire({ id: hitId }, strP(op, "event")); } catch { /* 跳过 */ }
      }
    }
    // 事件驱动：onClick 命中后级联整条 exec 链（含 flow.*/var.set 等控制流）
    for (const oc of onClickCascades) {
      if (!oc.targets.some((t) => t.id === hitId)) continue;
      for (const id of execNextOf(oc.ev.id)) cascadeExec(id);
    }
  }
  if (allClickOps.length) dom.addEventListener("pointerdown", onPointerDown);

  let elapsed = 0;

  // ----- 巡逻/追击步进状态 -----
  /** 巡逻相位（op.id\0target.id → 秒；周期由 距离/速度 推导） */
  const patrolPhase = new Map<string, number>();
  /** 巡逻基准位置（op.id\0target.id → 首次执行时的世界坐标） */
  const patrolBase = new Map<string, { x: number; y: number; z: number }>();
  /** 路径点模式：当前巡回的路径点下标（op.id\0target.id） */
  const patrolWaypointIdx = new Map<string, number>();

  /** 逐帧步进巡逻：路径口接入路径点 → 依次巡回；未接 → 沿轴三角波往返 */
  function stepPatrol(op: GNode, targets: NodeObj[], dt: number): void {
    // 路径点模式：路径口接入的实体位置即路径点（多入按连线顺序巡回）
    const waypoints = evalDataInputs(op.id, "path").filter(
      (v): v is NodeObj => v !== null && typeof v === "object" && "obj" in v,
    );
    if (waypoints.length) {
      const speed = numP(op, "speed", 2);
      for (const t of targets) {
        const key = `${op.id}\u0000${t.id}`;
        const idx = patrolWaypointIdx.get(key) ?? 0;
        const wp = waypoints[idx % waypoints.length];
        if (!wp) continue;
        const dx = wp.obj.position.x - t.obj.position.x;
        const dy = wp.obj.position.y - t.obj.position.y;
        const dz = wp.obj.position.z - t.obj.position.z;
        const len = Math.hypot(dx, dy, dz);
        if (len < 0.3) {
          patrolWaypointIdx.set(key, (idx + 1) % waypoints.length);
          continue;
        }
        const step = (speed * dt) / len;
        t.obj.position.x += dx * step;
        t.obj.position.y += dy * step;
        t.obj.position.z += dz * step;
      }
      return;
    }
    // 轴往返模式：沿轴在起点与起点+距离之间三角波往返
    const dist = numP(op, "distance", 6);
    const speed = numP(op, "speed", 2);
    const axis = strP(op, "axis", "x");
    const period = speed > 0 && dist > 0 ? (2 * dist) / speed : 0;
    if (period <= 0) return;
    for (const t of targets) {
      const key = `${op.id}\u0000${t.id}`;
      let base = patrolBase.get(key);
      if (!base) {
        base = { x: t.obj.position.x, y: t.obj.position.y, z: t.obj.position.z };
        patrolBase.set(key, base);
      }
      let phase = (patrolPhase.get(key) ?? 0) + dt;
      if (phase >= period) phase -= period;
      patrolPhase.set(key, phase);
      const half = period / 2;
      const off = (phase < half ? phase : period - phase) * speed;
      if (axis === "z") t.obj.position.z = base.z + off;
      else if (axis === "y") t.obj.position.y = base.y + off;
      else t.obj.position.x = base.x + off;
    }
  }

  /** 逐帧步进追击：朝 prey 实体匀速移动 */
  function stepChase(op: GNode, targets: NodeObj[], dt: number): void {
    const prey = evalDataInput(op.id, "prey");
    const target = Array.isArray(prey) ? prey[0] ?? null : (prey as NodeObj | null);
    if (!target) return;
    const speed = numP(op, "speed", 3);
    for (const t of targets) {
      const dx = target.obj.position.x - t.obj.position.x;
      const dy = target.obj.position.y - t.obj.position.y;
      const dz = target.obj.position.z - t.obj.position.z;
      const len = Math.hypot(dx, dy, dz);
      if (len < 0.05) continue;
      const step = (speed * dt) / len;
      t.obj.position.x += dx * step;
      t.obj.position.y += dy * step;
      t.obj.position.z += dz * step;
    }
  }

  /**
   * 导航移动：被移动对象每帧贴合导航代理的位姿（位置 + 朝向 + 高度偏移）。
   * 代理本体由导航运行时沿路径点巡回驱动——角色模型挂此操作即可"借"代理寻路
   * 巡逻，而不必自身是导航代理。
   */
  function stepNavMove(op: GNode, targets: NodeObj[]): void {
    const agentRaw = evalDataInput(op.id, "agent");
    const agent = Array.isArray(agentRaw) ? agentRaw[0] ?? null : (agentRaw as NodeObj | null);
    if (!agent) return;
    const yOff = numP(op, "yOffset", 0);
    for (const t of targets) {
      t.obj.position.x = agent.obj.position.x;
      t.obj.position.y = agent.obj.position.y + yOff;
      t.obj.position.z = agent.obj.position.z;
      t.obj.rotation.y = agent.obj.rotation.y;
    }
  }

  /** 逻辑容器的逐帧驱动：条件边轮询（比较节点上升沿 → 事件切状态）+ 激活状态的巡逻/追击步进 */
  let navPausedTargets = new Set<string>();
  function driveFsmContainers(dt: number): void {
    // 追击步进中涉及的实体（本帧暂停其导航巡回，追击结束自动恢复）
    const chaseTargetsNow = new Set<string>();
    for (const c of graph.nodes) {
      if (c.type !== "fsm.container") continue;
      // 条件边轮询：源为 flow.compare 的 event 入边，条件上升沿触发状态切换
      for (const e of graph.edges) {
        if (e.dstNode !== c.id || e.dstPort !== "event") continue;
        const src = nodeOf(e.srcNode);
        if (!src || src.type !== "flow.compare") continue;
        const key = `${c.id}\u0000${e.srcNode}`;
        const nowTrue = evalDataOutput(e.srcNode, "result") === true;
        const prev = fsmCondState.get(key);
        fsmCondState.set(key, nowTrue);
        if (nowTrue && prev === false) {
          enterFsmContainer(c, new Set(), strP(src, "event", ""), "event");
        }
      }
      // 激活状态的巡逻/追击步进
      const cur = fsmCurrent.get(c.id);
      if (cur === undefined) continue;
      for (const child of containerChildren(c.id)) {
        if (child.stateName && child.stateName !== cur) continue;
        const t = child.opType ?? child.type;
        if (t !== "op.patrol" && t !== "op.chase") continue;
        const targets = resolveTargets(child.id);
        if (!targets.length) continue;
        if (t === "op.patrol") stepPatrol(child, targets, dt);
        else {
          stepChase(child, targets, dt);
          for (const tt of targets) chaseTargetsNow.add(tt.id);
        }
      }
    }
    // 追击目标 → 暂停导航巡回；脱离追击 → 恢复
    for (const id of chaseTargetsNow) {
      if (!navPausedTargets.has(id)) navApi?.setAgentPaused(id, true);
    }
    for (const id of navPausedTargets) {
      if (!chaseTargetsNow.has(id)) navApi?.setAgentPaused(id, false);
    }
    navPausedTargets = chaseTargetsNow;
  }
  const fsmCondState = new Map<string, boolean>();

  return {
    update(dt: number) {
      elapsed += dt;
      // 逻辑容器驱动：条件轮询 + 激活状态的巡逻/追击步进
      driveFsmContainers(dt);
      // tick 链每帧级联（var.set/flow.* 等非 spin/bob 节点；spin/bob 由下方 frame 循环处理）
      for (const entryId of tickChainEntries) {
        cascadeExec(entryId);
      }
      for (const behavior of frameOps) {
        const { node, targets, baseY } = behavior;
        const opType = node.opType ?? node.type;
        // 容器内帧行为：所属状态未激活时暂停（激活恢复后从基准位继续）
        if (!nodeActive(node)) continue;
        if (opType === "op.spin") {
          const dx = numP(node, "speedX") * DEG * dt;
          const dy = numP(node, "speedY") * DEG * dt;
          const dz = numP(node, "speedZ") * DEG * dt;
          for (const t of targets) {
            if (dx) t.obj.rotation.x += dx;
            if (dy) t.obj.rotation.y += dy;
            if (dz) t.obj.rotation.z += dz;
          }
        } else if (opType === "op.bob") {
          const amp = numP(node, "amplitude");
          const period = numP(node, "period", 2);
          if (period <= 0 || !amp) continue;
          const y = amp * Math.sin((elapsed / period) * Math.PI * 2);
          for (const t of targets) {
            const base = baseY.get(t.id) ?? t.obj.position.y;
            t.obj.position.y = base + y;
          }
        } else if (opType === "op.patrol") {
          stepPatrol(node, targets, dt);
        } else if (opType === "op.chase") {
          stepChase(node, targets, dt);
        } else if (opType === "op.navMove") {
          stepNavMove(node, targets);
        }
      }
    },
    dispose() {
      dom.removeEventListener("pointerdown", onPointerDown);
    },
  };
}
