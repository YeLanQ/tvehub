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
  /** 灯光组件（明确属性节点：原型卡生成与灯光组件卡对镜的灯光卡；非灯光为 null） */
  light: EntityLight | null;
  /** 脚本组件（携带用户脚本的节点：解析 @property 生成脚本卡） */
  scripts: EntityScript[];
  /** 逻辑运行器组件（状态机/行为树运行器；无则 null） */
  logic: EntityLogic | null;
  /** 类型摘要行（按节点类型提取关键设置；灯光/脚本/逻辑另有专属卡） */
  summary: SummaryRow[];
  /** 原始文档节点（只读参照） */
  raw: JsonRecord;
}

/** 原型卡类型摘要行 */
export interface SummaryRow {
  label: string;
  value: string;
}

/** 灯光组件快照（与编辑器 LightComponentSettings 对齐的只读子集） */
export interface EntityLight {
  /** 灯光类型（point/directional/spot/ambient） */
  kind: string;
  /** 光色（0xRRGGBB） */
  color: number;
  intensity: number;
  distance: number;
  /** 聚光灯半角（度） */
  angle: number;
  penumbra: number;
  castShadow: boolean;
}

/** 脚本组件快照（属性 schema 由 scripts store 按 @property 懒解析） */
export interface EntityScript {
  /** 脚本源路径（项目相对，如 "src/spin.ts"） */
  script: string;
  /** 执行顺序（小者先跑） */
  executionOrder: number;
  /** 已存储的属性值（key → 字面量；schema 外的键忽略） */
  props: Record<string, unknown>;
}

/** 逻辑运行器组件快照（状态机/行为树运行器） */
export interface EntityLogic {
  kind: "fsm" | "bt";
  /** 逻辑资产引用（.fsm/.bt 相对路径） */
  asset: string;
  autoStart: boolean;
}

/** 层级树节点（实体 + 子级，供层级面板渲染） */
export interface EntityTreeNode {
  entity: SceneEntity;
  children: EntityTreeNode[];
  depth: number;
}

/**
 * 按节点类型提取关键设置摘要（原型卡「类型卡」分区）：
 * 覆盖编辑器可创建的全部节点类型——网格/粒子/地形/相机/音频/天空盒/雾/
 * 导航/UI 系列；灯光走灯光卡、脚本走脚本卡、状态机/行为树走逻辑卡。
 * 字段读取均为宽松快照（缺失/非法显示 —），不抛错。
 */
function typeSummary(type: string, raw: JsonRecord): SummaryRow[] {
  const rows: SummaryRow[] = [];
  const n1 = (v: unknown): string =>
    typeof v === "number" && Number.isFinite(v) ? String(Math.round(v * 10) / 10) : "—";
  const n0 = (v: unknown): string =>
    typeof v === "number" && Number.isFinite(v) ? String(Math.round(v)) : "—";
  const sv = (v: unknown): string => (typeof v === "string" && v ? v : "—");
  const bv = (v: unknown): string => (v === true ? "是" : v === false ? "否" : "—");

  switch (type) {
    case "meshNode": {
      const source = typeof raw.source === "string" ? raw.source : "primitive";
      rows.push({ label: source === "model" ? "模型" : "形状", value: source === "model" ? sv(raw.model) : sv(raw.shape) });
      break;
    }
    case "particleSystemNode": {
      const p = (raw.particles ?? {}) as Record<string, unknown>;
      rows.push(
        { label: "发射率", value: `${n0(p.emissionRate)}/s` },
        { label: "最大粒子", value: n0(p.maxParticles) },
        { label: "生命周期", value: `${n1(p.startLifetime)}s` },
        { label: "形状", value: sv(p.shape) },
      );
      break;
    }
    case "terrainNode": {
      const t = (raw.terrain ?? {}) as Record<string, unknown>;
      rows.push(
        { label: "尺寸", value: n0(t.size) },
        { label: "网格", value: n0(t.segments) },
        { label: "高度", value: n0(t.heightScale) },
        { label: "种子", value: n0(t.seed) },
      );
      break;
    }
    case "cameraNode": {
      const kind = sv(raw.cameraType) === "—" ? "perspective" : sv(raw.cameraType);
      rows.push({ label: "类型", value: kind });
      if (kind !== "orthographic") rows.push({ label: "FOV", value: `${n0(raw.fov)}°` });
      rows.push({ label: "裁剪", value: `${n1(raw.near)} / ${n0(raw.far)}` });
      break;
    }
    case "audioNode": {
      const a = (raw.audio ?? {}) as Record<string, unknown>;
      rows.push(
        { label: "音频", value: sv(a.source) },
        { label: "音量", value: n1(a.volume) },
        { label: "循环", value: bv(a.loop) },
      );
      break;
    }
    case "skyboxNode": {
      rows.push(
        { label: "类型", value: sv(raw.skyKind) },
        { label: "材质", value: sv(raw.material) },
      );
      break;
    }
    case "fogNode": {
      rows.push(
        { label: "类型", value: sv(raw.fogKind) },
        { label: "颜色", value: typeof raw.fog === "object" && raw.fog !== null ? n1((raw.fog as Record<string, unknown>).density) : "—" },
      );
      break;
    }
    case "navAgentNode":
    case "navAreaNode": {
      rows.push({ label: "导航", value: type === "navAgentNode" ? "导航代理" : "导航区域" });
      break;
    }
    case "uiTextNode": {
      rows.push({ label: "文本", value: sv(raw.text) });
      break;
    }
    case "uiImageNode": {
      rows.push({ label: "图片", value: sv(raw.path ?? (raw.settings as Record<string, unknown> | undefined)?.path) });
      break;
    }
    case "uiCanvasNode":
    case "uiLayoutNode":
    case "uiButtonNode": {
      rows.push({ label: "UI", value: type === "uiCanvasNode" ? "画布根" : type === "uiLayoutNode" ? "布局容器" : "按钮" });
      break;
    }
    default:
      break;
  }
  return rows;
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
  const num = (v: unknown, fb: number) => (typeof v === "number" && Number.isFinite(v) ? v : fb);
  const bool = (v: unknown, fb: boolean) => (typeof v === "boolean" ? v : fb);
  const str = (v: unknown, fb = "") => (typeof v === "string" ? v : fb);
  const nodeType = str(raw.type);

  // 灯光：两条来源——light 组件（任意节点附加）与灯光节点（pointLightNode 等，
  // 参数写在节点顶层字段）。统一收敛为灯光卡快照
  const LIGHT_NODE_KINDS: Record<string, string> = {
    lightNode: "point",
    pointLightNode: "point",
    directionalLightNode: "directional",
    spotLightNode: "spot",
    ambientLightNode: "ambient",
  };
  const lightComp = components.find((c) => (c as Record<string, unknown>)?.type === "light") as
    | { light?: Record<string, unknown> }
    | undefined;
  const l = (lightComp?.light ?? {}) as Record<string, unknown>;
  let light: EntityLight | null = lightComp
    ? {
        kind: str(l.kind, "point"),
        color: num(l.lightColor, 0xffffff),
        intensity: num(l.intensity, 1),
        distance: num(l.distance, 0),
        angle: num(l.angle, 30),
        penumbra: num(l.penumbra, 0.2),
        castShadow: bool(l.castShadow, false),
      }
    : null;
  if (!light && LIGHT_NODE_KINDS[nodeType]) {
    light = {
      kind: LIGHT_NODE_KINDS[nodeType],
      color: num(raw.lightColor, 0xffffff),
      intensity: num(raw.intensity, 1),
      distance: num(raw.distance, 0),
      angle: num(raw.angle, 30),
      penumbra: num(raw.penumbra, 0.2),
      castShadow: bool(raw.castShadow, false),
    };
  }

  // 脚本组件：源路径 + 执行顺序 + 已存储属性值（@property schema 由脚本 store 懒解析）
  const scripts: EntityScript[] = [];
  for (const c of components) {
    const cc = c as Record<string, unknown>;
    if (cc?.type !== "script") continue;
    const rawProps = (cc.props ?? {}) as Record<string, unknown>;
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawProps)) props[k] = v;
    scripts.push({
      script: str(cc.script),
      executionOrder: num(cc.executionOrder, 0),
      props,
    });
  }
  scripts.sort((a, b) => a.executionOrder - b.executionOrder);

  // 逻辑运行器：fsmRunnerNode / btRunnerNode 节点自身即运行器（settings 携带资产引用）
  let logic: EntityLogic | null = null;
  if (nodeType === "fsmRunnerNode" || nodeType === "btRunnerNode") {
    const s = (raw.settings ?? {}) as Record<string, unknown>;
    logic = {
      kind: nodeType === "btRunnerNode" ? "bt" : "fsm",
      asset: str(s.asset),
      autoStart: bool(s.autoStart, false),
    };
  }

  return {
    id: typeof raw.id === "string" ? raw.id : "",
    name: typeof raw.name === "string" ? raw.name : "",
    type: nodeType,
    tag: typeof raw.tag === "string" ? raw.tag : "",
    active: raw.active !== false,
    visible: raw.visible !== false,
    parentId: typeof raw.parentId === "string" ? raw.parentId : "",
    position: vec(t.position),
    rotation: vec(t.rotation),
    scale: vec(t.scale),
    light,
    scripts,
    logic,
    summary: typeSummary(nodeType, raw),
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
