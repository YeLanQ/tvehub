// ---------------------------------------------------------------------------
// 场景图内置运行时语义模块（与框架层 core-* manifest 双端对齐的另一半）。
//
// 每个 createCore* 工厂产出一个 GraphRuntimeModule（每次图装配新建实例，
// 模块内部状态——FSM 当前状态、巡逻相位、表达式缓存——天然按图隔离）。
// 注入模块（L1 脚本图模块）与本文件模块经同一张 handler 表合并，无特权差异。
//
// 模块清单：
// - core-entity     实体集源解析（entity.proto 精确 / entity.match 标签|类型）
// - core-ops        一次性原子操作（op.set / op.setFsmParam / op.toggleVisible / op.fireFsm）
// - core-drivers    驱动器（op.spin / op.bob / op.patrol / op.chase / op.navMove）
// - core-data       拉模型数据求值（var / flow.compare / loop 上下文 / math / sense / custom 表达式）
// - core-exec       执行链路由（var.set / flow.branch / flow.for / flow.forEach / flow.while）
// - core-containers 容器行为（fsm.container 状态机 / bt.container 行为树）
// ---------------------------------------------------------------------------

import type * as THREE from "three";
import { type GCustomNodeDef, type GNode } from "../../framework/graph";
import {
  DEG,
  unwrapEntities,
  unwrapEntity,
  toNum,
  toStr,
  type ContainerBehavior,
  type DataValue,
  type GraphKernel,
  type GraphRuntimeModule,
  type NodeObj,
} from "./graph-runtime";

// ---------------------------------------------------------------------------
// 属性路径写入（Entity 暴露的分量：position/rotation/scale 各分量 + visible）
// ---------------------------------------------------------------------------

/** 变换/可见性分量写入（度制输入 → 弧度） */
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
    case "light.intensity": (light as THREE.Light).intensity = value; return true;
    case "light.distance": (light as THREE.PointLight).distance = value; return true;
    case "light.angle": (light as THREE.SpotLight).angle = value * DEG; return true;
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// core-entity：实体集源解析
// ---------------------------------------------------------------------------

export function createCoreEntityModule(): GraphRuntimeModule {
  return {
    id: "core-entity",
    resolvers: {
      "entity.proto": (k, node) => {
        const eid = node.entityId ?? "";
        const hit = k.sceneById.get(eid);
        if (!hit) {
          // 原型实体缺失 → 目标集为空 → 下游行为静默不动；给出可定位告警
          // （常见原因：实体被删除/重建、图与场景版本不一致、预览的不是同一场景）
          k.warnOnce(
            `proto-miss:${eid}`,
            `[graph] 原型节点 ${node.id} 引用的场景实体 "${eid || "(空)"}" 在运行场景中不存在——该原型不产生目标（请确认实体未被删除/重建，且预览的是同一场景）`,
          );
          return [];
        }
        return [hit];
      },
      "entity.match": (k, node) => {
        const p = node.matchPattern ?? "";
        if (!p) return [];
        return k.sceneAll.filter((n) => (node.matchMode === "type" ? n.kind === p : n.tag === p));
      },
    },
  };
}

// ---------------------------------------------------------------------------
// core-ops：一次性原子操作
// ---------------------------------------------------------------------------

export function createCoreOpsModule(): GraphRuntimeModule {
  return {
    id: "core-ops",
    ops: {
      "op.set": (k, node, targets) => {
        if (!targets.length) return;
        const path = k.strP(node, "property");
        const value = k.numP(node, "value");
        for (const t of targets) {
          if (!setPath(t.obj, path, value)) setLightPath(t.obj, path, value);
        }
      },
      "op.setFsmParam": (k, node, targets) => {
        if (!targets.length) return;
        for (const t of targets) {
          try { k.logicApi.setParam({ id: t.id }, k.strP(node, "param"), k.numP(node, "value")); } catch { /* 跳过 */ }
        }
      },
      "op.toggleVisible": (_k, _node, targets) => {
        if (!targets.length) return;
        for (const t of targets) t.obj.visible = !t.obj.visible;
      },
      "op.fireFsm": (k, node, targets) => {
        if (!targets.length) return;
        for (const t of targets) {
          try { k.logicApi.fire({ id: t.id }, k.strP(node, "event")); } catch { /* 跳过 */ }
        }
      },
    },
  };
}

// ---------------------------------------------------------------------------
// core-drivers：帧驱动 + 实例态（基准位/相位/路径下标随 DriverInstance 走）
// ---------------------------------------------------------------------------

/** 路径点巡回去重距离（米） */
const WAYPOINT_ARRIVE = 0.3;
/** 追击停止距离（米） */
const CHASE_STOP = 0.05;

export function createCoreDriversModule(): GraphRuntimeModule {
  return {
    id: "core-drivers",
    drivers: {
      // 持续旋转：每帧按角速度（度/秒）累计
      "op.spin": (k, node) => ({
        step(dt, targets) {
          const dx = k.numP(node, "speedX") * DEG * dt;
          const dy = k.numP(node, "speedY", 45) * DEG * dt;
          const dz = k.numP(node, "speedZ") * DEG * dt;
          for (const t of targets) {
            if (dx) t.obj.rotation.x += dx;
            if (dy) t.obj.rotation.y += dy;
            if (dz) t.obj.rotation.z += dz;
          }
        },
      }),
      // 上下浮动：正弦往复平移 Y（以 boot 捕获的基准位为准）
      "op.bob": (k, node) => {
        const baseY = new Map<string, number>();
        return {
          boot(targets) {
            for (const t of targets) baseY.set(t.id, t.obj.position.y);
          },
          step(dt, targets) {
            void dt;
            const amp = k.numP(node, "amplitude");
            const period = k.numP(node, "period", 2);
            if (period <= 0 || !amp) return;
            const y = amp * Math.sin((k.elapsed() / period) * Math.PI * 2);
            for (const t of targets) {
              const base = baseY.get(t.id) ?? t.obj.position.y;
              t.obj.position.y = base + y;
            }
          },
        };
      },
      // 路径巡逻：路径口接入路径点 → 依次巡回；未接 → 沿轴在起点与起点+距离间往返
      "op.patrol": (k, node) => {
        /** 巡逻相位（target.id → 秒；周期由 距离/速度 推导） */
        const phase = new Map<string, number>();
        /** 巡逻基准位置（target.id → 首次执行时的世界坐标） */
        const base = new Map<string, { x: number; y: number; z: number }>();
        /** 路径点模式：当前巡回的路径点下标 */
        const wpIdx = new Map<string, number>();
        return {
          step(dt, targets) {
            // 路径点模式：路径口接入的实体位置即路径点（多入按连线顺序巡回）
            const waypoints = k.evalInputs(node.id, "path").map(unwrapEntity).filter((v): v is NodeObj => !!v);
            if (waypoints.length) {
              const speed = k.numP(node, "speed", 2);
              for (const t of targets) {
                const idx = wpIdx.get(t.id) ?? 0;
                const wp = waypoints[idx % waypoints.length];
                if (!wp) continue;
                const dx = wp.obj.position.x - t.obj.position.x;
                const dy = wp.obj.position.y - t.obj.position.y;
                const dz = wp.obj.position.z - t.obj.position.z;
                const len = Math.hypot(dx, dy, dz);
                if (len < WAYPOINT_ARRIVE) {
                  wpIdx.set(t.id, (idx + 1) % waypoints.length);
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
            const dist = k.numP(node, "distance", 6);
            const speed = k.numP(node, "speed", 2);
            const axis = k.strP(node, "axis", "x");
            const period = speed > 0 && dist > 0 ? (2 * dist) / speed : 0;
            if (period <= 0) return;
            for (const t of targets) {
              let b = base.get(t.id);
              if (!b) {
                b = { x: t.obj.position.x, y: t.obj.position.y, z: t.obj.position.z };
                base.set(t.id, b);
              }
              let ph = (phase.get(t.id) ?? 0) + dt;
              if (ph >= period) ph -= period;
              phase.set(t.id, ph);
              const half = period / 2;
              const off = (ph < half ? ph : period - ph) * speed;
              if (axis === "z") t.obj.position.z = b.z + off;
              else if (axis === "y") t.obj.position.y = b.y + off;
              else t.obj.position.x = b.x + off;
            }
          },
        };
      },
      // 追击目标：每帧朝 prey 引脚实体匀速移动
      "op.chase": (k, node) => ({
        step(dt, targets) {
          const prey = unwrapEntity(k.evalInput(node.id, "prey"));
          if (!prey) return;
          const speed = k.numP(node, "speed", 3);
          for (const t of targets) {
            const dx = prey.obj.position.x - t.obj.position.x;
            const dy = prey.obj.position.y - t.obj.position.y;
            const dz = prey.obj.position.z - t.obj.position.z;
            const len = Math.hypot(dx, dy, dz);
            if (len < CHASE_STOP) continue;
            const step = (speed * dt) / len;
            t.obj.position.x += dx * step;
            t.obj.position.y += dy * step;
            t.obj.position.z += dz * step;
          }
        },
      }),
      // 导航移动：每帧贴合导航代理位姿（位置 + 朝向 + 高度偏移）
      "op.navMove": (k, node) => ({
        step(_dt, targets) {
          const agent = unwrapEntity(k.evalInput(node.id, "agent"));
          if (!agent) return;
          const yOff = k.numP(node, "yOffset", 0);
          for (const t of targets) {
            t.obj.position.x = agent.obj.position.x;
            t.obj.position.y = agent.obj.position.y + yOff;
            t.obj.position.z = agent.obj.position.z;
            t.obj.rotation.y = agent.obj.rotation.y;
          }
        },
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// core-data：拉模型数据求值
// ---------------------------------------------------------------------------

/** 自定义节点表达式（编译缓存；inputIds + fieldKeys + Math 注入） */
interface CompiledExpr {
  fn: (...args: unknown[]) => unknown;
  inputIds: string[];
  fieldKeys: string[];
}

export function createCoreDataModule(): GraphRuntimeModule {
  // 自定义节点表达式编译缓存（type\0port → 编译产物；null = 无可编译表达式）
  const customExprCache = new Map<string, CompiledExpr | null>();
  const customDefMap = new Map<string, GCustomNodeDef>();
  let customInited = false;
  function initCustom(k: GraphKernel): void {
    if (customInited) return;
    customInited = true;
    for (const def of k.graph.customNodes ?? []) {
      customDefMap.set(def.type, def);
      for (const out of def.outputs ?? []) {
        const expr = def.expressions?.[out.id];
        if (!expr) {
          customExprCache.set(`${def.type}\u0000${out.id}`, null);
          continue;
        }
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
  }

  // 数学节点：标量二元/一元求值工厂
  const numIn = (k: GraphKernel, node: GNode, port: string): number => toNum(k.evalInput(node.id, port));

  /** 比较运算符求值（与框架层 G_COMPARE_OPERATORS 语义一致） */
  function compareValues(an: number, op: string, bn: number): boolean {
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

  return {
    id: "core-data",
    data: {
      "var.get": (k, node, portId) => (portId === "value" ? k.varGet(node.varId ?? "") : undefined),
      // var.set：输出 = 已写入的值（exec 链执行时写入 varStore，此处读回）
      "var.set": (k, node, portId) => (portId === "value" ? k.varGet(node.varId ?? "") : undefined),
      // flow.compare：a op b → boolean（B 引脚未连线时回退 params.b 参数值）
      "flow.compare": (k, node, portId) => {
        if (portId !== "result") return undefined;
        const an = numIn(k, node, "a");
        const bRaw = k.evalInput(node.id, "b");
        const bn = bRaw === null ? k.numP(node, "b") : toNum(bRaw);
        return compareValues(an, k.strP(node, "operator", ">"), bn);
      },
      "flow.for": (k, node, portId) => (portId === "index" ? k.loopIndex(node.id) ?? 0 : undefined),
      "flow.forEach": (k, node, portId) => {
        if (portId !== "item") return undefined;
        const item = k.loopItem(node.id);
        return item ? [item] : null;
      },
      // 算术
      "math.add": (k, node) => numIn(k, node, "a") + numIn(k, node, "b"),
      "math.sub": (k, node) => numIn(k, node, "a") - numIn(k, node, "b"),
      "math.mul": (k, node) => numIn(k, node, "a") * numIn(k, node, "b"),
      "math.div": (k, node) => { const bv = numIn(k, node, "b"); return bv === 0 ? 0 : numIn(k, node, "a") / bv; },
      "math.mod": (k, node) => { const bv = numIn(k, node, "b"); return bv === 0 ? 0 : numIn(k, node, "a") % bv; },
      // 三角（角度制输入）
      "math.sin": (k, node) => Math.sin(numIn(k, node, "a") * DEG),
      "math.cos": (k, node) => Math.cos(numIn(k, node, "a") * DEG),
      "math.tan": (k, node) => Math.tan(numIn(k, node, "a") * DEG),
      // 向量
      "math.vec3Make": (k, node, portId) =>
        portId === "v"
          ? { x: numIn(k, node, "x"), y: numIn(k, node, "y"), z: numIn(k, node, "z") }
          : null,
      "math.vec3Break": (k, node, portId) => {
        const v = k.evalInput(node.id, "v");
        const vec = (v && typeof v === "object" && !Array.isArray(v) && "x" in v && "y" in v && "z" in v)
          ? (v as { x: number; y: number; z: number })
          : { x: 0, y: 0, z: 0 };
        if (portId === "x") return vec.x;
        if (portId === "y") return vec.y;
        if (portId === "z") return vec.z;
        return null;
      },
      // 字符串
      "math.stringConcat": (k, node) => toStr(k.evalInput(node.id, "a")) + toStr(k.evalInput(node.id, "b")),
      "math.toString": (k, node) => toStr(k.evalInput(node.id, "value")),
      // 插值/工具
      "math.lerp": (k, node) => { const av = numIn(k, node, "a"), bv = numIn(k, node, "b"), t = numIn(k, node, "t"); return av + (bv - av) * t; },
      "math.clamp": (k, node) => Math.max(numIn(k, node, "min"), Math.min(numIn(k, node, "max"), numIn(k, node, "value"))),
      "math.abs": (k, node) => Math.abs(numIn(k, node, "a")),
      // 感知：两实体世界距离（原型卡接线后每帧拉取求值）
      "sense.distance": (k, node) => {
        const from = unwrapEntity(k.evalInput(node.id, "from"));
        const to = unwrapEntity(k.evalInput(node.id, "to"));
        if (!from || !to) return 0;
        return Math.hypot(
          from.obj.position.x - to.obj.position.x,
          from.obj.position.y - to.obj.position.y,
          from.obj.position.z - to.obj.position.z,
        );
      },
    },
    // 自定义节点（expression 能力类型）：按输出端口的 JS 表达式求值
    prefixData: {
      "custom.": (k, node, portId) => {
        initCustom(k);
        const compiled = customExprCache.get(`${node.type}\u0000${portId}`);
        if (!compiled) return null;
        const args: unknown[] = [];
        for (const id of compiled.inputIds) args.push(k.evalInput(node.id, id));
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
      },
    },
  };
}

// ---------------------------------------------------------------------------
// core-exec：执行链路由节点（var.set / flow.*）
// ---------------------------------------------------------------------------

/** flow.for 最大迭代数（防参数错致页面冻结） */
const FOR_MAX_ITER = 100000;
/** flow.while 最大迭代数（防死循环） */
const WHILE_MAX_ITER = 10000;

export function createCoreExecModule(): GraphRuntimeModule {
  return {
    id: "core-exec",
    executors: {
      // var.set：从 value 入引脚拉取数据 → 写入图变量 → 级联 next
      "var.set": (k, node, ec) => {
        const val = k.evalInput(node.id, "value");
        if (val !== null) k.varSet(node.varId ?? "", val);
        k.cascadeNext(node, ec);
      },
      // flow.branch：条件选择 true/false 分支（分支名兼作容器事件名）
      "flow.branch": (k, node, ec) => {
        const cond = k.evalInput(node.id, "condition") === true;
        const port = cond ? "true" : "false";
        for (const t of k.execTargetsOf(node.id, port)) {
          k.cascade(t.id, { seen: ec.seen, viaSrcPort: port, viaDstPort: t.dstPort, eventName: ec.fireEv || port });
        }
      },
      // flow.compare：纯数据节点，exec 链中不执行（由数据求值处理），链路透传
      "flow.compare": (k, node, ec) => {
        k.cascadeNext(node, ec);
      },
      // flow.for：计数循环（每次触发 loop，索引可拉取）
      "flow.for": (k, node, ec) => {
        const start = k.numP(node, "start", 0);
        const end = k.numP(node, "end", 10);
        const step = k.numP(node, "step", 1);
        const loop = k.execTargetsOf(node.id, "loop");
        const completed = k.execTargetsOf(node.id, "completed");
        let iter = 0;
        for (let i = start; (step > 0 ? i < end : i > end) && iter < FOR_MAX_ITER; i += step, iter++) {
          k.setLoopIndex(node.id, i);
          for (const t of loop) k.cascade(t.id, { seen: new Set(), viaSrcPort: "loop", viaDstPort: t.dstPort, eventName: ec.fireEv });
        }
        k.clearLoopIndex(node.id);
        for (const t of completed) k.cascade(t.id, { seen: ec.seen, viaSrcPort: "completed", viaDstPort: t.dstPort, eventName: ec.fireEv });
      },
      // flow.forEach：实体集遍历（当前实体可拉取）
      "flow.forEach": (k, node, ec) => {
        const items = unwrapEntities(k.evalInput(node.id, "array"));
        const loop = k.execTargetsOf(node.id, "loop");
        const completed = k.execTargetsOf(node.id, "completed");
        for (const item of items) {
          k.setLoopItem(node.id, item);
          for (const t of loop) k.cascade(t.id, { seen: new Set(), viaSrcPort: "loop", viaDstPort: t.dstPort, eventName: ec.fireEv });
        }
        for (const t of completed) k.cascade(t.id, { seen: ec.seen, viaSrcPort: "completed", viaDstPort: t.dstPort, eventName: ec.fireEv });
      },
      // flow.while：条件循环（最多 WHILE_MAX_ITER 次防死循环）
      "flow.while": (k, node, ec) => {
        const loop = k.execTargetsOf(node.id, "loop");
        const completed = k.execTargetsOf(node.id, "completed");
        for (let i = 0; i < WHILE_MAX_ITER; i++) {
          if (k.evalInput(node.id, "condition") !== true) break;
          for (const t of loop) k.cascade(t.id, { seen: new Set(), viaSrcPort: "loop", viaDstPort: t.dstPort, eventName: ec.fireEv });
        }
        for (const t of completed) k.cascade(t.id, { seen: ec.seen, viaSrcPort: "completed", viaDstPort: t.dstPort, eventName: ec.fireEv });
      },
    },
  };
}

// ---------------------------------------------------------------------------
// core-containers：逻辑容器行为（fsm 状态机 / bt 行为树；可嵌套）
// ---------------------------------------------------------------------------

/** 追击类型键（容器帧钩子据此收集本帧被追击实体 → 暂停其导航巡回） */
const CHASE_TYPE = "op.chase";

export function createCoreContainersModule(): GraphRuntimeModule {
  /** FSM 容器当前状态（containerId → 状态名；未激活无键） */
  const fsmCurrent = new Map<string, string>();
  /** FSM 条件边上一次求值（containerId\0srcId → 上帧结果；上升沿触发切换） */
  const fsmCondState = new Map<string, boolean>();
  /** 追击涉及的实体（本帧暂停其导航巡回，追击结束自动恢复；跨容器聚合） */
  let navPausedTargets = new Set<string>();
  /** 本帧追击目标聚合（全部容器 frame 后统一 flush，与旧 driveFsmContainers 时序一致） */
  let chaseTargetsNow = new Set<string>();

  /**
   * FSM 进入/事件切换：exec 入「进入」激活 initial；「event」入端口按事件名切换。
   * 激活状态 = 执行 containerId 归属且 stateName 匹配（无标签则任意状态）的
   * 直接子节点链，随后级联容器 next 下游。
   */
  function fsmSwitch(k: GraphKernel, node: GNode, seen: Set<string>, evName: string, viaDstPort: string): void {
    const states = k.strP(node, "states").split(",").map((s) => s.trim()).filter(Boolean);
    if (!states.length) return;
    const initial = k.strP(node, "initial", states[0]) || states[0];
    let target: string;
    if (viaDstPort === "event") {
      if (!evName || !states.includes(evName)) return; // 非状态事件忽略
      target = evName;
    } else {
      target = states.includes(initial) ? initial : states[0];
    }
    fsmCurrent.set(node.id, target);
    // 执行归属当前状态的直接子节点链（无状态标签的子节点任意状态都执行）
    for (const child of k.containerChildren(node.id)) {
      if (child.stateName && child.stateName !== target) continue;
      k.cascade(child.id, { seen: new Set(), viaSrcPort: "next", viaDstPort: "exec" });
    }
    // 状态切换完成 → 容器 next 下游（事件名沿用触发方/新状态）
    for (const t of k.execTargetsOf(node.id, "next")) {
      k.cascade(t.id, { seen, viaSrcPort: "next", viaDstPort: t.dstPort, eventName: evName || target });
    }
  }

  const fsm: ContainerBehavior = {
    enter(k, node, ec) {
      fsmSwitch(k, node, ec.seen, ec.eventName || ec.viaSrcPort, ec.viaDstPort);
    },
    childActive(_k, container, child) {
      const cur = fsmCurrent.get(container.id);
      // FSM 未激活（无入边驱动的纯整理容器）视为全状态可用
      if (cur !== undefined && child.stateName && child.stateName !== cur) return false;
      return true;
    },
    frame(k, node, dt) {
      // 条件边轮询：源数据节点 result 引脚上升沿 → 事件切换状态
      for (const e of k.graph.edges) {
        if (e.dstNode !== node.id || e.dstPort !== "event") continue;
        const src = k.nodeOf(e.srcNode);
        if (!src || src.unresolved) continue;
        const key = `${node.id}\u0000${e.srcNode}`;
        const nowTrue = k.evalOutput(e.srcNode, "result") === true;
        const prev = fsmCondState.get(key);
        fsmCondState.set(key, nowTrue);
        if (nowTrue && prev === false) {
          fsmSwitch(k, node, new Set(), k.strP(src, "event"), "event");
        }
      }
      // 激活状态的子驱动器步进（纯容器驱动、不在全局 tick 链上的巡逻/追击/旋转等；
      // 已被 frameOps 步进的跳过，避免双重步进）
      const cur = fsmCurrent.get(node.id);
      if (cur === undefined) return;
      for (const child of k.containerChildren(node.id)) {
        if (child.stateName && child.stateName !== cur) continue;
        if (k.inFrameLoop(child.id)) continue;
        const targets = k.resolveTargets(child.id);
        if (!targets.length) continue;
        k.stepDriver(child, dt, targets);
        if (child.type === CHASE_TYPE) for (const tt of targets) chaseTargetsNow.add(tt.id);
      }
    },
    frameEnd(k) {
      // 追击目标 → 暂停导航巡回；脱离追击 → 恢复
      for (const id of chaseTargetsNow) {
        if (!navPausedTargets.has(id)) k.navApi?.setAgentPaused(id, true);
      }
      for (const id of navPausedTargets) {
        if (!chaseTargetsNow.has(id)) k.navApi?.setAgentPaused(id, false);
      }
      navPausedTargets = chaseTargetsNow;
      chaseTargetsNow = new Set();
    },
  };

  /** 进入 BT 容器：按子节点纵向排序依次执行归属节点链，完成级联 next 下游 */
  const bt: ContainerBehavior = {
    enter(k, node, ec) {
      for (const child of k.containerChildren(node.id)) {
        if (!k.nodeActive(child)) continue;
        k.cascade(child.id, { seen: new Set(), viaSrcPort: "next", viaDstPort: "exec" });
      }
      for (const t of k.execTargetsOf(node.id, "next")) {
        k.cascade(t.id, { seen: ec.seen, viaSrcPort: "next", viaDstPort: t.dstPort, eventName: "" });
      }
    },
  };

  return {
    id: "core-containers",
    containers: {
      "fsm.container": fsm,
      "bt.container": bt,
    },
  };
}

/** 全部内置运行时模块（createGraphBehaviors 装配时按序合并） */
export function createCoreGraphModules(): GraphRuntimeModule[] {
  return [
    createCoreEntityModule(),
    createCoreOpsModule(),
    createCoreDriversModule(),
    createCoreDataModule(),
    createCoreExecModule(),
    createCoreContainersModule(),
  ];
}
