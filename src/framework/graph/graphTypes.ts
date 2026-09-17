// ---------------------------------------------------------------------------
// 场景图（Scene Graph，与场景绑定的行为图）会话数据类型（framework 层，不依赖 app/api 与 three）。
//
// 场景图是一种"另外的编辑模式"：把层级中的实体拖入画布 → 按现有脚本语义
// 生成原型卡片（变换卡必然有；灯光节点带灯光属性；脚本组件带 @property 属性卡；
// 状态机拖入生成 FSM 容器卡）；卡片暴露的属性即编辑器/SDK 可操作的属性。
// 图上对这些原型施加原子操作（操作节点），可用标签/类型匹配做批量——
// 操作是预览运行时执行的逻辑，不回写编辑器场景。
//
// 因此本文档是"会话工作板"：随场景自动持久化（.tve 旁路，用户不感知文件），
// 预览导出时随产物注入，由运行时解释器（runtime/graph-behaviors）执行。
// ---------------------------------------------------------------------------

/** 节点种类：原型（拖入实体）/ 匹配（标签|类型筛选）/ 操作（原子行为）/ 事件（执行链入口） */
export type GNodeKind = "proto" | "match" | "op" | "event";

/** 图变量数据类型（标量；vec3 后续扩展） */
export type GVarDataType = "number" | "boolean" | "string";

/** 图变量（具名数据槽，全图共享；var.get/var.set 节点引用） */
export interface GVariable {
  /** 图内唯一 id（v1、v2…） */
  id: string;
  /** 用户可见名 */
  name: string;
  /** 数据类型 */
  dataType: GVarDataType;
  /** 初始值（运行时复位用） */
  value: number | boolean | string;
}

/** 自定义节点端口定义（用户可扩展节点类型的端口） */
export interface GCustomPort {
  id: string;
  label: string;
  dataType: string;
}

/** 自定义节点字段定义（检查器编辑的字面量参数） */
export interface GCustomField {
  key: string;
  label: string;
  kind: "number" | "boolean" | "string";
  fallback: number | boolean | string;
}

/** 自定义节点定义（用户定义的节点类型；表达式求值驱动） */
export interface GCustomNodeDef {
  /** 定义 id（cd1、cd2…） */
  id: string;
  /** 节点类型键（须以 "custom." 开头） */
  type: string;
  /** 显示名 */
  label: string;
  /** 描述 */
  desc: string;
  /** 颜色（#rrggbb） */
  color: string;
  /** 输入端口 */
  inputs: GCustomPort[];
  /** 输出端口 */
  outputs: GCustomPort[];
  /** 可编辑字段 */
  fields: GCustomField[];
  /** 每个输出端口的求值表达式（JS 表达式，可引用输入端口 id、字段 key、Math） */
  expressions: Record<string, string>;
}

/** 图节点（画布上的一个卡片） */
export interface GNode {
  /** 图内唯一 id（n1、n2…） */
  id: string;
  /** 节点类型键（注册表查找：如 "entity.proto"、"op.spin"、"event.onBegin"） */
  type: string;
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
  /** 显示名覆盖（缺省按 type 推导） */
  title?: string;
  /** var.get/var.set：引用的图变量 id */
  varId?: string;
  /** 旧格式 kind（迁移用，normalizeGraphDoc 后统一为 type） */
  kind?: string;
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

/** 场景图完整文档（随场景 sidecar 自动持久化 + 预览导出注入） */
export interface ScriptGraphDoc {
  nodes: GNode[];
  edges: GEdge[];
  comments: GComment[];
  /** 图变量（具名数据槽，var.get/var.set 引用） */
  variables?: GVariable[];
  /** 自定义节点定义（用户可扩展节点类型） */
  customNodes?: GCustomNodeDef[];
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

/** 深拷贝场景图 */
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

/** 图内不冲突的变量 id（v1、v2…） */
export function nextGraphVariableId(g: Pick<ScriptGraphDoc, "variables">): string {
  const vars = g.variables ?? [];
  let i = vars.length + 1;
  let id = `v${i}`;
  const used = new Set(vars.map((v) => v.id));
  while (used.has(id)) id = `v${++i}`;
  return id;
}

/** 图内不冲突的自定义节点定义 id（cd1、cd2…） */
export function nextCustomNodeDefId(g: Pick<ScriptGraphDoc, "customNodes">): string {
  const defs = g.customNodes ?? [];
  let i = defs.length + 1;
  let id = `cd${i}`;
  const used = new Set(defs.map((d) => d.id));
  while (used.has(id)) id = `cd${++i}`;
  return id;
}

/** 节点显示名（title 覆盖 → 实体名/匹配串/类型名） */
export function graphNodeLabel(
  node: GNode,
  resolve?: { entityName?: (id: string) => string | null; typeLabel?: (type: string) => string; varName?: (id: string) => string | null },
): string {
  const t = typeof node.title === "string" ? node.title.trim() : "";
  if (t) return t;
  if (node.type === "entity.proto") {
    return resolve?.entityName?.(node.entityId ?? "") || "原型";
  }
  if (node.type === "entity.match") {
    return node.matchMode === "type" ? `类型: ${node.matchPattern || "…"}` : `标签: ${node.matchPattern || "…"}`;
  }
  if (node.type === "var.get" || node.type === "var.set") {
    return resolve?.varName?.(node.varId ?? "") || "变量";
  }
  return resolve?.typeLabel?.(node.type) || node.type;
}

export { str as graphStr, num as graphNum };
