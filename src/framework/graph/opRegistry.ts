// ---------------------------------------------------------------------------
// 脚本图原子操作目录（单一事实源，编辑器面板/检查器/运行时解释器共用）：
// 每种操作 = 一种预览运行时行为，触发时机由类型固定 ——
// - start：运行时启动时执行一次（属性设置 / FSM 事件 / FSM 参数）；
// - frame：每帧执行（持续旋转 / 上下浮动，delta 累计语义）；
// - click：实体被点击时执行（显隐切换）。
// 参数表 fields 即卡片/检查器的可编辑项，缺省值同为新建与收敛回退。
// 运行语义与 tve SDK 对齐：属性路径即 Entity 暴露的属性（position/rotation/
// scale 各分量、visible），FSM 操作经 engine.logic（fire/setParam）。
// ---------------------------------------------------------------------------

/** 操作触发时机（由操作类型固定） */
export type GOpTrigger = "start" | "frame" | "click";

export interface GOpFieldDef {
  key: string;
  label: string;
  kind: "number" | "string" | "boolean";
  fallback: number | string | boolean;
  step?: number;
  placeholder?: string;
}

export interface GOpDef {
  /** 注册表键（如 "op.spin"） */
  type: string;
  label: string;
  /** 一句话语义（运行时解释约定） */
  desc: string;
  trigger: GOpTrigger;
  color: string;
  fields: GOpFieldDef[];
}

/** 触发时机显示名 */
export const G_OP_TRIGGER_LABEL: Record<GOpTrigger, string> = {
  start: "启动时",
  frame: "每帧",
  click: "点击时",
};

/** 可设属性路径候选（Entity 暴露的分量；setProperty 用） */
export const G_PROPERTY_PATHS = [
  "position.x",
  "position.y",
  "position.z",
  "rotation.x",
  "rotation.y",
  "rotation.z",
  "scale.x",
  "scale.y",
  "scale.z",
  "visible",
] as const;

const F_N = (key: string, label: string, fallback = 0, step = 0.1): GOpFieldDef => ({
  key,
  label,
  kind: "number",
  fallback,
  step,
});
const F_S = (key: string, label: string, fallback = "", placeholder?: string): GOpFieldDef => ({
  key,
  label,
  kind: "string",
  fallback,
  ...(placeholder ? { placeholder } : {}),
});

/** 原子操作注册表（顺序即展示顺序） */
export const GRAPH_OP_DEFS: GOpDef[] = [
  {
    type: "op.set",
    label: "设置属性",
    desc: "启动时把目标的指定属性设为 value（绝对值语义）",
    trigger: "start",
    color: "#4ec9b0",
    fields: [
      { key: "property", label: "属性", kind: "string", fallback: "position.y" },
      { key: "value", label: "值", kind: "number", fallback: 0, step: 0.1 },
    ],
  },
  {
    type: "op.spin",
    label: "持续旋转",
    desc: "每帧按角速度（度/秒）累计旋转",
    trigger: "frame",
    color: "#dcdcaa",
    fields: [F_N("speedX", "X 速度", 0, 1), F_N("speedY", "Y 速度", 45, 1), F_N("speedZ", "Z 速度", 0, 1)],
  },
  {
    type: "op.bob",
    label: "上下浮动",
    desc: "每帧按正弦往复平移 Y（幅度 · 周期秒；以启动位置为基准）",
    trigger: "frame",
    color: "#dcdcaa",
    fields: [F_N("amplitude", "幅度", 0.5, 0.1), F_N("period", "周期（秒）", 2, 0.1)],
  },
  {
    type: "op.fireFsm",
    label: "FSM 事件",
    desc: "向目标的状态机发送事件（语义同 engine.logic.fire）",
    trigger: "click",
    color: "#569cd6",
    fields: [F_S("event", "事件名", "", "如 hit")],
  },
  {
    type: "op.setFsmParam",
    label: "FSM 参数",
    desc: "写目标状态机黑板参数（语义同 engine.logic.setParam）",
    trigger: "start",
    color: "#569cd6",
    fields: [F_S("param", "参数名"), F_N("value", "值", 1, 0.1)],
  },
  {
    type: "op.toggleVisible",
    label: "点击显隐",
    desc: "目标被点击时切换可见性（指针射线命中实体）",
    trigger: "click",
    color: "#c586c0",
    fields: [],
  },
];

const OP_MAP = new Map(GRAPH_OP_DEFS.map((d) => [d.type, d]));

/** 按类型查操作定义（未知 null） */
export function graphOpDef(type: string): GOpDef | null {
  return OP_MAP.get(type) ?? null;
}

/** 操作默认参数表（新建填充） */
export function graphOpDefaults(type: string): Record<string, number | boolean | string> {
  const def = OP_MAP.get(type);
  const params: Record<string, number | boolean | string> = {};
  if (!def) return params;
  for (const f of def.fields) params[f.key] = f.fallback;
  return params;
}

/** 操作参数摘要（卡片第二行） */
export function graphOpSummary(type: string, params: Record<string, unknown> | undefined): string {
  const def = OP_MAP.get(type);
  if (!def) return "";
  const parts: string[] = [];
  for (const f of def.fields) {
    const v = params?.[f.key];
    if (v === undefined || v === "" || v === f.fallback) continue;
    parts.push(f.kind === "boolean" ? `${f.label}` : `${f.label} ${String(v)}`);
  }
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// 会话图收敛（侧车装载/快照恢复共用；放本文件以单向依赖 graphTypes）
// ---------------------------------------------------------------------------

import { graphPort, GRAPH_DEFAULT_COMMENT_COLOR, graphStr as str, graphNum as num } from "./graphTypes";
import type { GComment, GEdge, GNode, ScriptGraphDoc } from "./graphTypes";

const CLAMP_COORD = 20000;

/** 宽松形状校验（侧车装载预检） */
export function isGraphDoc(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o.nodes) && Array.isArray(o.edges);
}

/**
 * 任意来源 → 收敛的脚本图：
 * 节点 kind 合法、未知操作类型剔除、id 去重补齐、坐标钳制、proto.entityId 与
 * match 模式串收敛、op 参数按注册表字段钳制；连线端口存在/通道一致/自环剔除/
 * 入端口唯一（保首条）；注释框尺寸与文本钳制。
 */
export function normalizeGraphDoc(v: unknown): ScriptGraphDoc {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const clamp = (x: unknown) => Math.max(-CLAMP_COORD, Math.min(CLAMP_COORD, num(x, 0)));

  const nodes: GNode[] = [];
  const usedIds = new Set<string>();
  const takeId = (raw: unknown, prefix: string): string => {
    let id = typeof raw === "string" && raw && !usedIds.has(raw) ? raw : "";
    if (!id) {
      let i = usedIds.size + 1;
      id = `${prefix}${i}`;
      while (usedIds.has(id)) id = `${prefix}${++i}`;
    }
    usedIds.add(id);
    return id;
  };
  for (const rn of Array.isArray(o.nodes) ? o.nodes : []) {
    if (!rn || typeof rn !== "object") continue;
    const r = rn as Record<string, unknown>;
    const kind = str(r.kind);
    if (kind !== "proto" && kind !== "match" && kind !== "op") continue;
    const node: GNode = { id: takeId(r.id, "n"), kind, x: clamp(r.x), y: clamp(r.y) };
    if (kind === "proto") node.entityId = str(r.entityId);
    if (kind === "match") {
      node.matchMode = r.matchMode === "type" ? "type" : "tag";
      node.matchPattern = str(r.matchPattern).slice(0, 64);
    }
    if (kind === "op") {
      const def = OP_MAP.get(str(r.opType));
      if (!def) continue;
      node.opType = def.type;
      const params: Record<string, number | boolean | string> = {};
      const rawParams = (r.params && typeof r.params === "object" ? r.params : {}) as Record<string, unknown>;
      for (const f of def.fields) {
        const v = rawParams[f.key];
        if (f.kind === "number") params[f.key] = num(v, f.fallback as number);
        else if (f.kind === "boolean") params[f.key] = v === true;
        else params[f.key] = str(v, f.fallback as string).slice(0, 512);
      }
      node.params = params;
    }
    const title = str(r.title).trim().slice(0, 64);
    if (title) node.title = title;
    nodes.push(node);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const edges: GEdge[] = [];
  const usedEdgeIds = new Set<string>();
  const wired = new Set<string>();
  for (const re of Array.isArray(o.edges) ? o.edges : []) {
    if (!re || typeof re !== "object") continue;
    const r = re as Record<string, unknown>;
    const srcNode = str(r.srcNode);
    const srcPort = str(r.srcPort);
    const dstNode = str(r.dstNode);
    const dstPort = str(r.dstPort);
    const src = byId.get(srcNode);
    const dst = byId.get(dstNode);
    if (!src || !dst || srcNode === dstNode) continue;
    const sp = graphPort(src, srcPort, "out");
    const dp = graphPort(dst, dstPort, "in");
    if (!sp || !dp || sp.channel !== dp.channel) continue;
    const key = `${dstNode}\u0000${dstPort}`;
    if (wired.has(key)) continue;
    wired.add(key);
    let id = str(r.id);
    if (!id || usedEdgeIds.has(id)) {
      let i = usedEdgeIds.size + 1;
      id = `e${i}`;
      while (usedEdgeIds.has(id)) id = `e${++i}`;
    }
    usedEdgeIds.add(id);
    edges.push({ id, srcNode, srcPort, dstNode, dstPort });
  }

  const comments: GComment[] = [];
  for (const rc of Array.isArray(o.comments) ? o.comments : []) {
    if (!rc || typeof rc !== "object") continue;
    const r = rc as Record<string, unknown>;
    let id = str(r.id);
    if (!id || usedIds.has(id)) {
      let i = comments.length + 1;
      id = `c${i}`;
      while (comments.some((c) => c.id === id)) id = `c${++i}`;
    }
    comments.push({
      id,
      x: clamp(r.x),
      y: clamp(r.y),
      w: Math.max(80, Math.min(2000, num(r.w, 240))),
      h: Math.max(60, Math.min(2000, num(r.h, 140))),
      text: str(r.text).slice(0, 2000),
      color: /^#[0-9a-fA-F]{6}$/.test(str(r.color)) ? str(r.color) : GRAPH_DEFAULT_COMMENT_COLOR,
    });
  }

  return { nodes, edges, comments };
}

/** 空白脚本图（新场景/装载失败回退） */
export function emptyGraphDoc(): ScriptGraphDoc {
  return { nodes: [], edges: [], comments: [] };
}
