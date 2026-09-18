// ---------------------------------------------------------------------------
// 场景图运行时契约（kernel ↔ 运行时模块的 handler 接口）。
//
// 架构：graph-kernel 只实现与类型无关的引擎逻辑（exec 邻接/级联、拉模型数据
// 求值、实体集通道、容器递归与激活判定、驱动器实例调度、事件绑定、射线点击
// 服务）；一切类型语义由 GraphRuntimeModule 按类型键注册进来。内置语义在
// graph-core-modules.ts，注入模块（L1 脚本图模块）经 createGraphBehaviors 的
// modules 参数进入——与框架层 registerModule 的类型目录（manifest）双端对齐。
//
// 类型特判禁止清单（全部改走 framework 注册表 capability 位）：
// - 容器 → containers[type] 行为（enter/frame/childActive）
// - 实体集源 → resolvers[type]
// - 帧驱动 → drivers[type]（实例态归 DriverInstance，kernel 缓存共享）
// - 一次性操作 → ops[type]
// - 执行链路由（var.set/flow.*）→ executors[type]
// - 数据求值（math/var.get/compare/custom 表达式）→ data[type] / prefixData[前缀]
// ---------------------------------------------------------------------------

import type * as THREE from "three";
import type { GNode, ScriptGraphDoc } from "../../framework/graph";

/** 场景节点对象（buildSceneTree 打 userData.nodeId/nodeKind/nodeTag 标记） */
export interface NodeObj {
  obj: THREE.Object3D;
  id: string;
  kind: string;
  tag: string;
}

/** 数据引脚运行时值（标量 / vec3 / 单实体 / 实体集 / null=未连接） */
export type DataValue =
  | number
  | boolean
  | string
  | { x: number; y: number; z: number }
  | NodeObj
  | NodeObj[]
  | null;

/** exec 级联上下文（kernel cascade 派发时构造） */
export interface ExecCtx {
  /** 级联环防护集合 */
  seen: Set<string>;
  /** 触发本节点的源端口名 */
  viaSrcPort: string;
  /** 本节点被进入时命中的入端口名（容器 event 口判定用） */
  viaDstPort: string;
  /** 触发方携带的事件名（进入容器 event 口的状态名） */
  eventName: string;
  /** 向下游传递的事件名（本节点 params.event 优先，否则沿用触发方） */
  fireEv: string;
}

/** kernel 暴露给 handler 的引擎服务面 */
export interface GraphKernel {
  graph: ScriptGraphDoc;
  nodeOf(id: string): GNode | undefined;
  /** 场景实体索引（userData.nodeId 精确匹配源） */
  sceneById: Map<string, NodeObj>;
  sceneAll: NodeObj[];
  logicApi: GraphBehaviorsCtx["logicApi"];
  navApi: GraphBehaviorsCtx["navApi"];
  /** 参数读取（缺省回退：解析容错） */
  numP(node: GNode, key: string, fb?: number): number;
  strP(node: GNode, key: string, fb?: string): string;
  boolP(node: GNode, key: string, fb?: boolean): boolean;
  /** 实体集通道：源节点（proto/match/容器 out）/ 操作目标集（上游递归 + op 透传） */
  resolveSet(refId: string): NodeObj[];
  resolveTargets(opId: string): NodeObj[];
  /** 数据流（拉模型） */
  evalOutput(nodeId: string, portId: string, seen?: Set<string>): DataValue;
  evalInput(nodeId: string, portId: string): DataValue;
  evalInputs(nodeId: string, portId: string): DataValue[];
  /** exec 链级联（ec 缺省 = 新环防护集 + next/exec 通道） */
  cascade(nodeId: string, ec?: Partial<Omit<ExecCtx, "fireEv">>): void;
  /** 级联本节点某 exec 出端口的下游（fireEv/环集合沿用 ec） */
  cascadeNext(node: GNode, ec: ExecCtx, port?: string, eventName?: string): void;
  execTargetsOf(nodeId: string, port?: string): { id: string; dstPort: string }[];
  execNextOf(nodeId: string, port?: string): string[];
  /** 图变量存储 */
  varGet(varId: string): DataValue;
  varSet(varId: string, v: DataValue): void;
  /** 循环迭代上下文（flow.for 索引 / flow.forEach 当前实体） */
  loopIndex(id: string): number | undefined;
  setLoopIndex(id: string, i: number): void;
  clearLoopIndex(id: string): void;
  loopItem(id: string): NodeObj | undefined;
  setLoopItem(id: string, item: NodeObj): void;
  /** 清除遍历上下文（ForEach 遍历结束后调用：「当前」引脚回归空，不残留最后一个元素） */
  clearLoopItem(id: string): void;
  /** 容器：归属子节点（纵向排序）/ 归属链激活判定 */
  containerChildren(containerId: string): GNode[];
  nodeActive(node: GNode): boolean;
  /** 驱动器步进（实例经 kernel 缓存共享；targets 缺省按实体集通道解析） */
  stepDriver(node: GNode, dt: number, targets?: NodeObj[]): void;
  /** 该节点是否已被全局 frame 循环步进（容器 frame 钩子给状态内驱动步进前去重） */
  inFrameLoop(nodeId: string): boolean;
  /** 中断开关（gate 能力节点）当前是否导通（未登记 = 导通） */
  gateOpen(nodeId: string): boolean;
  /** 翻转中断开关锁存状态（「开/关」控制口触发；断开即中断下游执行链与帧驱动器） */
  setGateOpen(nodeId: string, open: boolean): void;
  /** 节点上游主执行链上是否存在断开的中断开关（帧驱动器步进门控） */
  driverGated(nodeId: string): boolean;
  /** 诊断告警（同 key 只提示一次；预览控制台实时回传编辑器，静默失败可定位） */
  warnOnce(key: string, msg: string): void;
  /** 诊断日志（info 级；同 key 最多输出 limit 次，缺省 1 次——逐帧语义不刷屏） */
  log(key: string, msg: string, limit?: number): void;
  /** 启动以来的累计时间（秒） */
  elapsed(): number;
  /** 脚本组件属性访问（script:<路径>:<属性> 寻址；player 未注入时该命名空间不可用） */
  scriptApi?: GraphScriptApi;
}

/** 原子操作执行器（一次性语义：属性设置 / 显隐 / FSM 事件…） */
export type OpExecutor = (k: GraphKernel, node: GNode, targets: NodeObj[]) => void;

/** 驱动器实例（帧驱动 + 实例态；boot 在目标解析后捕获基准值） */
export interface DriverInstance {
  boot?(targets: NodeObj[]): void;
  step(dt: number, targets: NodeObj[]): void;
}
/** 驱动器工厂（每节点一个实例，kernel 按 node.id 缓存共享） */
export type DriverFactory = (k: GraphKernel, node: GNode) => DriverInstance;

/** 数据求值器（拉模型纯求值；返回 undefined = 该端口不处理，kernel 走实体集回退） */
export type DataEvaluator = (k: GraphKernel, node: GNode, portId: string) => DataValue | undefined;

/** 实体集源解析器（entitySource 能力类型：proto/match/…） */
export type TargetResolver = (k: GraphKernel, node: GNode) => NodeObj[];

/** 执行链节点执行器（var.set / flow.branch / flow.for …：自身语义 + 自行级联下游） */
export type ChainExecutor = (k: GraphKernel, node: GNode, ec: ExecCtx) => void;

/** 容器行为（container 能力类型：fsm/bt/…，可嵌套；kernel 按能力递归） */
export interface ContainerBehavior {
  /** exec 进入（event 口切换 / exec 口初始） */
  enter(k: GraphKernel, node: GNode, ec: ExecCtx): void;
  /** 每帧驱动（状态轮询、激活态子驱动步进等） */
  frame?(k: GraphKernel, node: GNode, dt: number): void;
  /** 本容器 frame 之后、全部容器帧驱动结束的聚合钩子（跨容器状态 flush 用） */
  frameEnd?(k: GraphKernel, dt: number): void;
  /** 子节点在本容器层是否激活（缺省恒激活） */
  childActive?(k: GraphKernel, container: GNode, child: GNode): boolean;
}

/**
 * 图运行时模块：把类型语义 handler 绑定到注册表类型键。
 * manifest（类型目录/端口/字段）在 framework 侧 registerModule；本接口是
 * 运行时侧的另一半——同一类型键，两份实现（编辑器认知 + 执行语义）。
 */
export interface GraphRuntimeModule {
  id: string;
  /** 一次性操作执行器 */
  ops?: Record<string, OpExecutor>;
  /** 驱动器工厂（帧驱动 + 实例态） */
  drivers?: Record<string, DriverFactory>;
  /** 数据求值器（按类型键） */
  data?: Record<string, DataEvaluator>;
  /** 数据求值器（按类型前缀；data 表未命中时兜底，如 "custom." 表达式） */
  prefixData?: Record<string, DataEvaluator>;
  /** 执行链节点执行器（路由型：var.set/flow.*） */
  executors?: Record<string, ChainExecutor>;
  /** 实体集源解析器 */
  resolvers?: Record<string, TargetResolver>;
  /** 容器行为 */
  containers?: Record<string, ContainerBehavior>;
  /** 装配清理 */
  dispose?(): void;
}

/** 脚本组件属性访问器（script:<路径>:<属性>；由 player 经 scripts 运行时注入） */
export interface GraphScriptApi {
  /** 读 @property 实时值（非脚本/键不存在/对象值 → null） */
  getProp(nodeId: string, scriptRel: string, key: string): number | boolean | string | null;
  /** 写 @property（字段模式可写；legacy 只读视图回 false） */
  setProp(nodeId: string, scriptRel: string, key: string, value: number | boolean | string): boolean;
  /**
   * 接入口交付（原型卡「接入」→ 实体上脚本实例；可选，旧宿主缺省不可用）：
   * value 为 DataValue[]（实体集已展开为单实体项）；交付给该实体全部存活脚本
   * （写入 this.graphInput 并回调 onGraphInput），无人接收回 false。
   */
  setGraphInput?(nodeId: string, scriptRel: string, value: unknown): boolean;
}

/** 运行时装配上下文（player 注入） */
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
  navApi?: {
    setAgentPaused(id: string, paused: boolean): void;
    /** 任意两点寻路（op.chase 用）：烘焙网格 A* 平滑路径点（世界系）；无可达路线/无区域 → null */
    pathBetween?(
      from: { x: number; z: number },
      to: { x: number; z: number },
    ): { x: number; y: number; z: number }[] | null;
  };
  /** 脚本组件属性访问（可选）：属性路径的 script: 命名空间 */
  scriptApi?: GraphScriptApi;
}

export interface GraphBehaviorsHandle {
  update(dt: number): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// 数值提取工具（DataValue 收敛；handler 共用）
// ---------------------------------------------------------------------------

/** 数值提取（DataValue → number，非数值回退 0） */
export function toNum(v: DataValue): number {
  return typeof v === "number" ? v : 0;
}
/** 字符串提取（DataValue → string；vec3/实体按可读形式收敛） */
export function toStr(v: DataValue): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(Math.round(v * 1000) / 1000);
  if (typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map((x) => x.id).join(", ")}]`;
  if (v && typeof v === "object") {
    if ("obj" in v) return v.id || v.obj.name || "(实体)";
    if ("x" in v && "y" in v && "z" in v) {
      const s = (n: number) => Math.round(n * 1000) / 1000;
      return `(${s(v.x)}, ${s(v.y)}, ${s(v.z)})`;
    }
  }
  return "";
}
/** 实体提取（DataValue → 首个 NodeObj；单实体/实体集通吃） */
export function unwrapEntity(v: DataValue): NodeObj | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v && typeof v === "object" && "obj" in v ? (v as NodeObj) : null;
}
/** 实体集提取（DataValue → NodeObj[]） */
export function unwrapEntities(v: DataValue): NodeObj[] {
  return Array.isArray(v) ? v : [];
}

/** 度 → 弧度 */
export const DEG = Math.PI / 180;
