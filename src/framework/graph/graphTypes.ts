// ---------------------------------------------------------------------------
// 脚本图（Script Graph）会话数据类型（framework 层，不依赖 app/api 与 three）。
//
// 脚本图是一种"另外的编辑模式"：把层级中的实体拖入画布 → 按现有脚本语义
// 生成原型卡片（变换卡必然有；灯光节点带灯光属性；脚本组件带 @property 属性卡；
// 状态机拖入生成 FSM 容器卡）；卡片暴露的属性即编辑器/SDK 可操作的属性。
// 图上对这些原型施加原子操作（操作节点），可用标签/类型匹配做批量——
// 操作是预览运行时执行的逻辑，不回写编辑器场景。
//
// 因此本文档是"会话工作板"：随场景自动持久化（.tve 旁路，用户不感知文件），
// 预览导出时随产物注入，由运行时解释器（runtime/graph-behaviors）执行。
// ---------------------------------------------------------------------------

/** 节点种类：原型（拖入实体）/ 匹配（标签|类型筛选）/ 操作（原子行为） */
export type GNodeKind = "proto" | "match" | "op";

/** 图节点（画布上的一个卡片） */
export interface GNode {
  /** 图内唯一 id（n1、n2…） */
  id: string;
  kind: GNodeKind;
  /** 画布坐标（卡片左上角） */
  x: number;
  y: number;
  /** proto：拖入的场景实体 id（原型引用源，属性以场景当前值为参照） */
  entityId?: string;
  /** match：匹配模式与模式串 */
  matchMode?: "tag" | "type";
  matchPattern?: string;
  /** op：操作类型（须在 OP_DEFS 注册）+ 参数表 */
  opType?: string;
  params?: Record<string, number | boolean | string>;
  /** 显示名覆盖（缺省按 kind/type 推导） */
  title?: string;
}

/**
 * 连线：srcPort/dstPort 约定 ——
 * - 实体集通道：proto/match 的 "out" → op 的 "in"（决定操作作用对象，可多入）；
 * - 执行链通道：op 的 "next" → op 的 "exec"（应用时级联下游，单入）。
 */
export interface GEdge {
  /** 连线 id（e1、e2…） */
  id: string;
  srcNode: string;
  srcPort: string;
  dstNode: string;
  dstPort: string;
}

/** 注释框（纯画布元素） */
export interface GComment {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  color: string;
}

/** 脚本图完整文档（随场景 sidecar 自动持久化 + 预览导出注入） */
export interface ScriptGraphDoc {
  nodes: GNode[];
  edges: GEdge[];
  comments: GComment[];
}

/** 注释框可选主题色 */
export const GRAPH_COMMENT_COLORS = ["#dcdcaa", "#4ec9b0", "#c586c0", "#569cd6", "#ce9178"] as const;

/** 注释框默认色 */
export const GRAPH_DEFAULT_COMMENT_COLOR = "#dcdcaa";

function str(v: unknown, fb = ""): string {
  return typeof v === "string" ? v : fb;
}
function num(v: unknown, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fb;
}

/** 深拷贝脚本图 */
export function cloneGraphDoc(g: ScriptGraphDoc): ScriptGraphDoc {
  return JSON.parse(JSON.stringify(g)) as ScriptGraphDoc;
}

/** 图内不冲突的节点 id（n1、n2…） */
export function nextGraphNodeId(g: Pick<ScriptGraphDoc, "nodes">): string {
  let i = g.nodes.length + 1;
  let id = `n${i}`;
  const used = new Set(g.nodes.map((n) => n.id));
  while (used.has(id)) id = `n${++i}`;
  return id;
}

/** 图内不冲突的连线 id（e1、e2…） */
export function nextGraphEdgeId(g: Pick<ScriptGraphDoc, "edges">): string {
  let i = g.edges.length + 1;
  let id = `e${i}`;
  const used = new Set(g.edges.map((e) => e.id));
  while (used.has(id)) id = `e${++i}`;
  return id;
}

/** 图内不冲突的注释框 id（c1、c2…） */
export function nextGraphCommentId(g: Pick<ScriptGraphDoc, "comments">): string {
  let i = g.comments.length + 1;
  let id = `c${i}`;
  const used = new Set(g.comments.map((c) => c.id));
  while (used.has(id)) id = `c${++i}`;
  return id;
}

/**
 * 节点的端口定义（kind = 通道类型）：
 * - proto/match：源端口 "out"（实体集）；
 * - op：目标端口 "in"（实体集，单入）与 "exec"（执行链，单入），
 *   源端口 "out"（实体集透传，供操作串联共用同一目标集）与 "next"（执行链）。
 */
export interface GPortInfo {
  id: string;
  direction: "in" | "out";
  /** 通道：entities = 实体集；exec = 执行链 */
  channel: "entities" | "exec";
}

export function graphNodePorts(node: GNode): GPortInfo[] {
  if (node.kind === "proto" || node.kind === "match") {
    return [{ id: "out", direction: "out", channel: "entities" }];
  }
  return [
    { id: "in", direction: "in", channel: "entities" },
    { id: "exec", direction: "in", channel: "exec" },
    { id: "out", direction: "out", channel: "entities" },
    { id: "next", direction: "out", channel: "exec" },
  ];
}

/** 查节点端口（不存在 null） */
export function graphPort(node: GNode, portId: string, direction: "in" | "out"): GPortInfo | null {
  return graphNodePorts(node).find((p) => p.id === portId && p.direction === direction) ?? null;
}

/** 两端口能否相连（通道一致即可；方向由调用方保证 src=out / dst=in） */
export function canConnectPorts(src: GPortInfo, dst: GPortInfo): boolean {
  return src.channel === dst.channel;
}

/** 节点显示名（title 覆盖 → 实体名/匹配串/操作名） */
export function graphNodeLabel(
  node: GNode,
  resolve?: { entityName?: (id: string) => string | null; opLabel?: (type: string) => string },
): string {
  const t = typeof node.title === "string" ? node.title.trim() : "";
  if (t) return t;
  if (node.kind === "proto") {
    return resolve?.entityName?.(node.entityId ?? "") || "原型";
  }
  if (node.kind === "match") {
    return node.matchMode === "type" ? `类型: ${node.matchPattern || "…"}` : `标签: ${node.matchPattern || "…"}`;
  }
  return resolve?.opLabel?.(node.opType ?? "") || "操作";
}

export { str as graphStr, num as graphNum };
