// ---------------------------------------------------------------------------
// 行为树（Behavior Tree）数据类型（framework 层，不依赖 app/api 与 three）。
//
// 行为树资产（.bt）持有可 JSON 序列化的节点树：组合节点（选择/顺序/并行）、
// 装饰节点（反转/强制成功/重复/重试/超时）、叶子节点（等待/条件/动作）。
// 节点类型注册表 BT_NODE_DEFS 是编辑器面板（类型清单/字段表单/子节点数校验）
// 与 parse 收敛（未知类型剔除、字段钳制）的单一事实源。
// 运行语义见 behaviorRuntime.ts（success/failure/running 三值 + running 记忆）。
// ---------------------------------------------------------------------------

/** 节点求值状态 */
export type BTStatus = "success" | "failure" | "running";

/** 参数条件比较运算（布尔黑板值按 0/1 参与比较；与状态机条件同形） */
export type BTConditionOp = ">" | "<" | ">=" | "<=" | "==" | "!=";

/** 行为树节点（单接口 + 可选字段，字段含义随 type 由注册表定义） */
export interface BTNode {
  /** 节点 id（树内唯一；n1、n2…） */
  id: string;
  /** 节点类型（须在 BT_NODE_DEFS 注册） */
  type: string;
  /** 显示名（空 = 类型默认名） */
  name?: string;
  /** wait / timeout：时长秒数 */
  seconds?: number;
  /** repeat / retry：次数（<=0 = 无限） */
  count?: number;
  /** condition：参数名 */
  param?: string;
  /** condition：比较运算 */
  op?: BTConditionOp;
  /** condition：比较值 */
  value?: number;
  /** action：动作名（运行时经 onAction 处理器解析；未注册动作按成功处理） */
  action?: string;
  /** 子节点（组合节点任意，装饰节点至多 1，叶子无） */
  children: BTNode[];
}

/** 节点类别（编辑器分组展示） */
export type BTNodeCategory = "composite" | "decorator" | "leaf";

/** 注册表字段定义（编辑器属性表单按此渲染） */
export interface BTFieldDef {
  key: "seconds" | "count" | "param" | "op" | "value" | "action";
  label: string;
  kind: "number" | "string" | "option";
  /** option 的候选（op 用） */
  options?: BTConditionOp[];
  /** number 的取值域/步进 */
  min?: number;
  max?: number;
  step?: number;
  /** 缺省值（新建节点时填充；parse 缺字段回退） */
  fallback: number | string;
}

/** 注册表项：一种节点类型的全部静态信息 */
export interface BTNodeDef {
  type: string;
  label: string;
  /** 一句话语义说明（编辑器提示用） */
  desc: string;
  category: BTNodeCategory;
  /** 最多子节点数（组合 -1 = 无限；装饰 1；叶子 0） */
  maxChildren: number;
  /** 编辑器卡片主题色（CSS hex） */
  color: string;
  fields: BTFieldDef[];
}

const OP_FIELDS: BTFieldDef[] = [
  { key: "param", label: "参数", kind: "string", fallback: "" },
  { key: "op", label: "运算", kind: "option", options: [">", "<", ">=", "<=", "==", "!="], fallback: ">=" },
  { key: "value", label: "数值", kind: "number", step: 0.1, fallback: 0 },
];

/** 行为树节点类型注册表（顺序即编辑器展示顺序） */
export const BT_NODE_DEFS: BTNodeDef[] = [
  {
    type: "selector",
    label: "选择",
    desc: "依次尝试子节点，一个成功即成功；全失败才失败",
    category: "composite",
    maxChildren: -1,
    color: "#dcdcaa",
    fields: [],
  },
  {
    type: "sequence",
    label: "顺序",
    desc: "依次执行子节点，一个失败即失败；全成功才成功",
    category: "composite",
    maxChildren: -1,
    color: "#dcdcaa",
    fields: [],
  },
  {
    type: "parallel",
    label: "并行",
    desc: "每帧执行全部子节点；任一失败即失败，全部成功才成功",
    category: "composite",
    maxChildren: -1,
    color: "#dcdcaa",
    fields: [],
  },
  {
    type: "invert",
    label: "反转",
    desc: "子节点成功↔失败互换（running 原样透传）",
    category: "decorator",
    maxChildren: 1,
    color: "#c586c0",
    fields: [],
  },
  {
    type: "succeeder",
    label: "强制成功",
    desc: "无论子节点结果如何都返回成功",
    category: "decorator",
    maxChildren: 1,
    color: "#c586c0",
    fields: [],
  },
  {
    type: "repeat",
    label: "重复",
    desc: "子节点成功后重新执行，达到次数后成功；子节点失败立即失败",
    category: "decorator",
    maxChildren: 1,
    color: "#c586c0",
    fields: [{ key: "count", label: "次数（0 = 无限）", kind: "number", min: 0, step: 1, fallback: 0 }],
  },
  {
    type: "retry",
    label: "重试",
    desc: "子节点失败后重新执行，达到次数后失败；子节点成功立即成功",
    category: "decorator",
    maxChildren: 1,
    color: "#c586c0",
    fields: [{ key: "count", label: "次数（0 = 无限）", kind: "number", min: 0, step: 1, fallback: 0 }],
  },
  {
    type: "timeout",
    label: "超时",
    desc: "子节点运行超过时限仍未完成则失败",
    category: "decorator",
    maxChildren: 1,
    color: "#c586c0",
    fields: [{ key: "seconds", label: "时限（秒）", kind: "number", min: 0.05, step: 0.1, fallback: 1 }],
  },
  {
    type: "wait",
    label: "等待",
    desc: "持续指定秒数，期间 running，到时成功",
    category: "leaf",
    maxChildren: 0,
    color: "#4ec9b0",
    fields: [{ key: "seconds", label: "时长（秒）", kind: "number", min: 0, step: 0.1, fallback: 1 }],
  },
  {
    type: "condition",
    label: "条件",
    desc: "检查黑板参数是否满足比较式，成立成功否则失败",
    category: "leaf",
    maxChildren: 0,
    color: "#4ec9b0",
    fields: OP_FIELDS,
  },
  {
    type: "action",
    label: "动作",
    desc: "执行具名动作（运行时经处理器解析；未注册动作按成功处理）",
    category: "leaf",
    maxChildren: 0,
    color: "#4ec9b0",
    fields: [{ key: "action", label: "动作名", kind: "string", fallback: "" }],
  },
];

const DEF_MAP = new Map(BT_NODE_DEFS.map((d) => [d.type, d]));

/** 按类型查注册表项（未知类型 null） */
export function btNodeDef(type: string): BTNodeDef | null {
  return DEF_MAP.get(type) ?? null;
}

/** 节点显示名（name 优先，否则类型默认名） */
export function btNodeLabel(n: BTNode): string {
  return n.name?.trim() || btNodeDef(n.type)?.label || n.type;
}

/** 节点摘要（编辑器卡片第二行：关键参数一览） */
export function btNodeSummary(n: BTNode): string {
  const def = btNodeDef(n.type);
  if (!def) return "";
  const parts: string[] = [];
  if (n.seconds !== undefined) parts.push(`${round2(n.seconds)}s`);
  if (n.count !== undefined) parts.push(n.count > 0 ? `×${n.count}` : "∞");
  if (n.param) parts.push(`${n.param} ${n.op ?? ">="} ${round2(n.value ?? 0)}`);
  if (n.action) parts.push(n.action);
  return parts.join(" ");
}

function round2(v: number): string {
  const s = v.toFixed(2);
  return s.endsWith(".00") ? s.slice(0, -3) : s.replace(/0$/, "");
}

/** 深拷贝行为树（编辑器改树前的工作副本） */
export function cloneBehaviorTree(root: BTNode): BTNode {
  return JSON.parse(JSON.stringify(root)) as BTNode;
}

/** 生成树内不冲突的节点 id（n1、n2…） */
export function nextBtId(root: BTNode | null): string {
  const used = new Set<string>();
  const walk = (n: BTNode): void => {
    used.add(n.id);
    for (const c of n.children) walk(c);
  };
  if (root) walk(root);
  let i = used.size + 1;
  let id = `n${i}`;
  while (used.has(id)) id = `n${++i}`;
  return id;
}

/** 树内节点总数 */
export function countBtNodes(root: BTNode | null): number {
  if (!root) return 0;
  return 1 + root.children.reduce((s, c) => s + countBtNodes(c), 0);
}

/** 按 id 深度优先查节点（不存在 null） */
export function findBtNode(root: BTNode | null, id: string): BTNode | null {
  if (!root) return null;
  if (root.id === id) return root;
  for (const c of root.children) {
    const hit = findBtNode(c, id);
    if (hit) return hit;
  }
  return null;
}

/** 按 id 查父节点（根返回 null） */
export function findBtParent(root: BTNode | null, id: string): BTNode | null {
  if (!root) return null;
  for (const c of root.children) {
    if (c.id === id) return root;
    const hit = findBtParent(c, id);
    if (hit) return hit;
  }
  return null;
}

/** 从树中移除节点（含子树；id=根时返回 null 表示空树） */
export function removeBtNode(root: BTNode, id: string): BTNode | null {
  if (root.id === id) return null;
  const filter = (n: BTNode): void => {
    n.children = n.children.filter((c) => c.id !== id);
    for (const c of n.children) filter(c);
  };
  filter(root);
  return root;
}

/** 节点还能否接受子节点 */
export function btCanAcceptChildren(n: BTNode): boolean {
  const def = btNodeDef(n.type);
  if (!def) return false;
  return def.maxChildren < 0 || n.children.length < def.maxChildren;
}

/**
 * 任意来源 → 收敛的行为树（空树/根无效返回 null）：
 * 未知类型整枝剔除、叶子/装饰的越权子节点裁剪、id 去重补齐、字段按注册表钳制。
 */
export function parseBehaviorTree(v: unknown): BTNode | null {
  const usedIds = new Set<string>();
  const takeId = (raw: unknown): string => {
    let id = typeof raw === "string" && raw && !usedIds.has(raw) ? raw : "";
    if (!id) {
      let i = usedIds.size + 1;
      id = `n${i}`;
      while (usedIds.has(id)) id = `n${++i}`;
    }
    usedIds.add(id);
    return id;
  };
  const str = (v: unknown, fb = ""): string => (typeof v === "string" ? v : fb);
  const numOr = (v: unknown, fb: number, lo?: number): number => {
    const n = typeof v === "number" && Number.isFinite(v) ? v : fb;
    return lo !== undefined ? Math.max(lo, n) : n;
  };

  function parseNode(raw: unknown): BTNode | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    const def = btNodeDef(str(o.type));
    if (!def) return null;
    const node: BTNode = { id: takeId(o.id), type: def.type, children: [] };
    const name = str(o.name).trim();
    if (name) node.name = name;
    for (const f of def.fields) {
      const bag = node as unknown as Record<string, unknown>;
      if (f.kind === "number") {
        bag[f.key] = numOr(o[f.key], f.fallback as number, f.min);
      } else if (f.kind === "option") {
        const v = o[f.key];
        bag[f.key] =
          typeof v === "string" && f.options?.includes(v as BTConditionOp) ? v : (f.fallback as string);
      } else {
        bag[f.key] = str(o[f.key], f.fallback as string);
      }
    }
    if (def.maxChildren !== 0) {
      const rawChildren = Array.isArray(o.children) ? o.children : [];
      const limit = def.maxChildren < 0 ? Infinity : def.maxChildren;
      for (const rc of rawChildren) {
        if (node.children.length >= limit) break;
        const child = parseNode(rc);
        if (child) node.children.push(child);
      }
    }
    return node;
  }

  return parseNode(v);
}

/** 新建行为树资产的默认树（根 = 顺序节点挂一个条件 + 一个动作，开箱可读） */
export function defaultBehaviorTree(): BTNode {
  return parseBehaviorTree({
    type: "sequence",
    children: [
      { type: "action", action: "idle" },
      { type: "wait", seconds: 1 },
    ],
  }) as BTNode;
}

/** 行为树资产扩展名 */
export const BT_EXT = ".bt";

/** 是否行为树资产相对路径（按扩展名判断） */
export function isBtAssetRel(rel: string): boolean {
  return rel.toLowerCase().endsWith(BT_EXT);
}
