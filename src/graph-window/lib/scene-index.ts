// ---------------------------------------------------------------------------
// 场景实体索引（图窗口侧）：sceneApi.doc() 的文档树遍历为扁平实体表，
// 供原型卡片显示实时属性、匹配节点按标签/类型求值、检查器展示。
// 文档节点形状（与 Node.toJSON 对齐）：type/id/name/parentId/childIds/
// active/visible/transform{position,rotation,scale}/properties (+ tag/
// components 等非缺省字段)，children 为嵌套数组。
// ---------------------------------------------------------------------------

import { sceneApi } from "../../lib/scene-api";
import type { JsonRecord } from "../../framework/prototype/types";

/** 场景实体（图窗口视角的只读快照） */
export interface SceneEntity {
  id: string;
  name: string;
  /** 节点类型键（node/meshNode/lightNode/fsmRunnerNode…） */
  type: string;
  tag: string;
  active: boolean;
  visible: boolean;
  parentId: string;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  /** 灯光节点：灯光分量摘要（非灯光为 null） */
  light: { intensity: number; distance: number } | null;
  /** 原始文档节点（只读参照） */
  raw: JsonRecord;
}

/** 层级树节点（实体 + 子级，供层级面板渲染） */
export interface EntityTreeNode {
  entity: SceneEntity;
  children: EntityTreeNode[];
  depth: number;
}

function vec(v: unknown): { x: number; y: number; z: number } {
  const o = (v ?? {}) as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  return { x: n(o.x), y: n(o.y), z: n(o.z) };
}

function toEntity(raw: JsonRecord): SceneEntity {
  const t = (raw.transform ?? {}) as Record<string, unknown>;
  const components = Array.isArray(raw.components) ? raw.components : [];
  const lightComp = components.find((c) => (c as Record<string, unknown>)?.type === "light") as
    | { light?: Record<string, unknown> }
    | undefined;
  const l = lightComp?.light ?? {};
  const num = (v: unknown, fb: number) => (typeof v === "number" && Number.isFinite(v) ? v : fb);
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    name: typeof raw.name === "string" ? raw.name : "",
    type: typeof raw.type === "string" ? raw.type : "node",
    tag: typeof raw.tag === "string" ? raw.tag : "",
    active: raw.active !== false,
    visible: raw.visible !== false,
    parentId: typeof raw.parentId === "string" ? raw.parentId : "",
    position: vec(t.position),
    rotation: vec(t.rotation),
    scale: vec(t.scale),
    light: lightComp
      ? { intensity: num(l.intensity, 0), distance: num(l.distance, 0) }
      : null,
    raw,
  };
}

/** 文档树 → 扁平实体表（含根容器，与编辑器层级一致从 Root 展示；children 嵌套） */
export function collectEntities(doc: unknown): SceneEntity[] {
  const out: SceneEntity[] = [];
  const root = (doc as { root?: unknown } | null)?.root;
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    const children = Array.isArray(n.children) ? n.children : [];
    out.push(toEntity(n as JsonRecord));
    for (const c of children) walk(c);
  };
  walk(root);
  return out;
}

/** 拉取当前会话的场景实体索引 */
export async function fetchSceneEntities(): Promise<SceneEntity[]> {
  const doc = await sceneApi.doc();
  return collectEntities(doc);
}

/**
 * 扁平实体表 → 层级树（按 parentId 装配；孤儿挂根，保持 DFS 顺序）。
 * 根实体 = parentId 为空或父不在表内的实体。
 */
export function buildEntityTree(entities: SceneEntity[]): EntityTreeNode[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const made = new Map<string, EntityTreeNode>();
  const make = (e: SceneEntity): EntityTreeNode => {
    let t = made.get(e.id);
    if (t) return t;
    t = { entity: e, children: [], depth: 0 };
    made.set(e.id, t);
    const parent = e.parentId ? byId.get(e.parentId) : undefined;
    if (parent && parent !== e) {
      const pt = make(parent);
      t.depth = pt.depth + 1;
      pt.children.push(t);
    }
    return t;
  };
  const roots: EntityTreeNode[] = [];
  for (const e of entities) {
    const t = make(e);
    const parent = e.parentId ? byId.get(e.parentId) : undefined;
    if (!parent || parent === e) roots.push(t);
  }
  // 深度兜底重算（孤儿链装配顺序可能算错）
  const fixDepth = (t: EntityTreeNode, depth: number): void => {
    t.depth = depth;
    for (const c of t.children) fixDepth(c, depth + 1);
  };
  for (const r of roots) fixDepth(r, 0);
  return roots;
}

/** 层级树 → 扁平行（含深度；折叠过滤由面板侧处理） */
export function flattenEntityTree(
  tree: EntityTreeNode[],
  isCollapsed: (id: string) => boolean,
): { entity: SceneEntity; depth: number }[] {
  const rows: { entity: SceneEntity; depth: number }[] = [];
  const walk = (nodes: EntityTreeNode[]): void => {
    for (const t of nodes) {
      rows.push({ entity: t.entity, depth: t.depth });
      if (t.children.length && !isCollapsed(t.entity.id)) walk(t.children);
    }
  };
  walk(tree);
  return rows;
}

/** 按标签求值（空模式 = 空集） */
export function byTag(entities: SceneEntity[], tag: string): SceneEntity[] {
  return tag ? entities.filter((e) => e.tag === tag) : [];
}

/** 按类型求值（空模式 = 空集） */
export function byType(entities: SceneEntity[], type: string): SceneEntity[] {
  return type ? entities.filter((e) => e.type === type) : [];
}
