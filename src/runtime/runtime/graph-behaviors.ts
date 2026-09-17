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

const DEG = Math.PI / 180;

export function createGraphBehaviors(ctx: GraphBehaviorsCtx): GraphBehaviorsHandle {
  const { scene, dom, camera, logicApi, graph } = ctx;

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
    // flow.compare：求值 a op b → boolean
    if (node.type === "flow.compare" && portId === "result") {
      const a = evalDataInput(nodeId, "a");
      const b = evalDataInput(nodeId, "b");
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
    // ----- 数学/工具节点（纯数据求值） -----
    if (node.type.startsWith("math.")) {
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

  // ----- exec 链邻接：node.id → portId → 下游 exec 目标 node ids -----
  // 支持多 exec 出端口（next/true/false/loop/completed）
  const execOut = new Map<string, Map<string, string[]>>();
  for (const e of graph.edges) {
    if (e.dstPort !== "exec") continue;
    const portMap = execOut.get(e.srcNode) ?? new Map<string, string[]>();
    const list = portMap.get(e.srcPort) ?? [];
    list.push(e.dstNode);
    portMap.set(e.srcPort, list);
    execOut.set(e.srcNode, portMap);
  }
  /** 取节点某 exec 出端口的下游 ids */
  function execNextOf(nodeId: string, port = "next"): string[] {
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
      case "op.set":
        for (const t of targets) setPath(t.obj, strP(op, "property"), numP(op, "value"));
        break;
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

  /** exec 链级联：执行 op/var.set/flow.* → 沿 exec 出端口 → 下游 */
  function cascadeExec(opId: string, seen = new Set<string>()): void {
    if (seen.has(opId)) return;
    seen.add(opId);
    const node = nodeOf(opId);
    if (!node) return;
    // var.set：从 value 入引脚拉取数据 → 写入图变量
    if (node.type === "var.set") {
      const val = evalDataInput(opId, "value");
      if (val !== null) varStore.set(node.varId ?? "", val);
      for (const id of execNextOf(opId)) cascadeExec(id, seen);
      return;
    }
    // flow.branch：条件选择 true/false 分支
    if (node.type === "flow.branch") {
      const cond = evalDataInput(opId, "condition") === true;
      for (const id of execNextOf(opId, cond ? "true" : "false")) cascadeExec(id, seen);
      return;
    }
    // flow.compare：纯数据节点，exec 链中不执行（由 evalDataOutput 求值）
    if (node.type === "flow.compare") {
      for (const id of execNextOf(opId)) cascadeExec(id, seen);
      return;
    }
    // flow.for：计数循环
    if (node.type === "flow.for") {
      const start = numP(node, "start", 0);
      const end = numP(node, "end", 10);
      const step = numP(node, "step", 1);
      const loop = execNextOf(opId, "loop");
      const completed = execNextOf(opId, "completed");
      const maxIter = 100000;
      let iter = 0;
      for (let i = start; (step > 0 ? i < end : i > end) && iter < maxIter; i += step, iter++) {
        loopIndex.set(opId, i);
        for (const id of loop) cascadeExec(id, new Set());
      }
      loopIndex.delete(opId);
      for (const id of completed) cascadeExec(id, seen);
      return;
    }
    // flow.forEach：实体集遍历
    if (node.type === "flow.forEach") {
      const arr = evalDataInput(opId, "array");
      const items = Array.isArray(arr) ? arr : [];
      const loop = execNextOf(opId, "loop");
      const completed = execNextOf(opId, "completed");
      for (const item of items) {
        loopItem.set(opId, item);
        for (const id of loop) cascadeExec(id, new Set());
      }
      loopItem.delete(opId);
      for (const id of completed) cascadeExec(id, seen);
      return;
    }
    // flow.while：条件循环（最多 10000 次防死循环）
    if (node.type === "flow.while") {
      const loop = execNextOf(opId, "loop");
      const completed = execNextOf(opId, "completed");
      const maxIter = 10000;
      for (let i = 0; i < maxIter; i++) {
        if (evalDataInput(opId, "condition") !== true) break;
        for (const id of loop) cascadeExec(id, new Set());
      }
      for (const id of completed) cascadeExec(id, seen);
      return;
    }
    // op.*：执行操作
    if (!node.type.startsWith("op.")) return;
    const targets = resolveTargets(opId);
    executeOp(node, targets);
    for (const id of execNextOf(opId)) cascadeExec(id, seen);
  }

  // ----- 事件节点 -----
  const eventNodes = graph.nodes.filter((n) => n.type.startsWith("event."));
  const onBeginNodes = eventNodes.filter((n) => n.type === "event.onBegin");
  const onTickNodes = eventNodes.filter((n) => n.type === "event.onTick");
  const onClickNodes = eventNodes.filter((n) => n.type === "event.onClick");

  // ----- 旧式操作（无 exec 入边，按 trigger 独立执行；向后兼容） -----
  const legacyOps = graph.nodes.filter(
    (n) => n.type.startsWith("op.") && !hasExecInput.has(n.id),
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
  // 事件驱动的 tick 链中 op.spin/op.bob 需逐帧执行
  const tickChainOps: GNode[] = [];
  // tick 链入口节点（每帧级联执行 var.set/flow.* 等非 spin/bob 节点）
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
    if (op.type === "op.spin" || op.type === "op.bob") tickChainOps.push(op);
    // 遍历所有 exec 出端口（next/true/false/loop/completed）
    const portMap = execOut.get(opId);
    if (portMap) for (const [, ids] of portMap) for (const id of ids) collectFrameOps(id, seen);
  }
  // 合并事件驱动 + 旧式 frame ops
  const allFrameOps = [...legacySpinOps, ...legacyBobOps, ...tickChainOps];
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

  return {
    update(dt: number) {
      elapsed += dt;
      // tick 链每帧级联（var.set/flow.* 等非 spin/bob 节点；spin/bob 由下方 frame 循环处理）
      for (const entryId of tickChainEntries) {
        cascadeExec(entryId);
      }
      for (const behavior of frameOps) {
        const { node, targets, baseY } = behavior;
        const opType = node.opType ?? node.type;
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
        }
      }
    },
    dispose() {
      dom.removeEventListener("pointerdown", onPointerDown);
    },
  };
}
