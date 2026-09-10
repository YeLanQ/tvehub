// ---------------------------------------------------------------------------
// 渲染层级与标签（Unity Tags and Layers 语义；framework 层，不依赖 app 与 three）。
//
// 层（Layer）：three.js 的 Object3D.layers 是 32 位掩码，项目最多 32 个命名层
// （索引 0~31）。节点单选一层（Unity Layer 语义，默认层 0），相机/灯光节点以
// cullingMask 位掩码筛选照亮的层。内置层 0 = "Default"，锁定不可删（Unity 同款）。
//
// 标签（Tag）：项目级命名列表（内置 "Untagged" 即空串，不进列表），节点 tag 存
// 自由字符串；脚本经 entity.tag / findByTag 按标签筛选，引擎不附加内置语义。
// 已存储但不在项目列表中的标签值原样保留显示（不静默清洗用户数据）。
//
// 项目配置存 project.config.json：
//   "tags":   ["Player", "Enemy"]          （不含内置 Untagged）
//   "layers": ["Default", null, "Enemy"]   （稀疏数组：下标即层索引，空位 = 未定义）
// 读取统一经 parse* 收敛（缺失/越界/重名回退），旧项目无字段 = 全默认。
// ---------------------------------------------------------------------------

/** 层数上限（three.js Object3D.layers 为 32 位掩码） */
export const MAX_LAYERS = 32;

/** 全部层的位掩码（int32 全 1；three 的 layers.mask 用同一表示） */
export const ALL_LAYERS_MASK = -1;

/** 内置层的固定索引与名称（锁定不可删不可改名，Unity Default 层同语义） */
export const BUILTIN_LAYER_INDEX = 0;
export const BUILTIN_LAYER_NAME = "Default";

/** 内置标签值（空串）与其显示名 */
export const UNTAGGED_TAG = "";
export const UNTAGGED_LABEL = "Untagged";

/**
 * 层表：稠密数组，下标即层索引，元素为层名（空串 = 该层未定义）。
 * 恒有 32 项；index 0 恒为内置 "Default"。
 */
export type LayerTable = string[];

function sanitizeLayerName(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 任意来源 → 收敛的层表（index 0 强制内置 Default；重名保留首个，其余置空） */
export function parseLayerTable(v: unknown): LayerTable {
  const raw = Array.isArray(v) ? v : [];
  const table: LayerTable = new Array(MAX_LAYERS).fill("");
  table[BUILTIN_LAYER_INDEX] = BUILTIN_LAYER_NAME;
  const seen = new Set<string>([BUILTIN_LAYER_NAME]);
  for (let i = 1; i < MAX_LAYERS && i < raw.length; i++) {
    const name = sanitizeLayerName(raw[i]);
    if (!name || seen.has(name)) continue;
    table[i] = name;
    seen.add(name);
  }
  return table;
}

/** 层表 → 稀疏数组存档形态（截掉尾部空位；index 0 恒在内） */
export function layerTableToJSON(table: LayerTable): string[] {
  let last = BUILTIN_LAYER_INDEX;
  for (let i = 0; i < table.length; i++) {
    if (table[i]) last = i;
  }
  const out: string[] = [];
  for (let i = 0; i <= last; i++) out.push(table[i] || "");
  return out;
}

/** 层是否已定义 */
export function isLayerDefined(table: LayerTable, index: number): boolean {
  return index >= 0 && index < MAX_LAYERS && !!table[index];
}

/** 层显示名：未定义的索引回退 "Layer N"（旧场景引用已删层的兜底显示） */
export function layerNameAt(table: LayerTable, index: number): string {
  if (index === BUILTIN_LAYER_INDEX) return BUILTIN_LAYER_NAME;
  return table[index] || `Layer ${index}`;
}

/** 按名查层索引（找不到返回 -1） */
export function layerIndexOfName(table: LayerTable, name: string): number {
  const key = name.trim();
  for (let i = 0; i < table.length; i++) {
    if (table[i] && table[i] === key) return i;
  }
  return -1;
}

/** 已定义层的索引升序列表 */
export function definedLayerIndices(table: LayerTable): number[] {
  const out: number[] = [];
  for (let i = 0; i < table.length; i++) {
    if (table[i]) out.push(i);
  }
  return out;
}

/** 最低的空闲层索引（1~31；全满返回 -1。层 0 内置占用） */
export function nextFreeLayerIndex(table: LayerTable): number {
  for (let i = 1; i < MAX_LAYERS; i++) {
    if (!table[i]) return i;
  }
  return -1;
}

/** 节点层索引收敛：任意来源 → int 0~31（越界/非数值回退 0） */
export function clampLayerIndex(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  const i = Math.round(v);
  return i >= 0 && i < MAX_LAYERS ? i : 0;
}

/** culling mask 收敛：任意来源 → int32 位掩码（缺失/非法回退全部层） */
export function parseCullingMask(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return ALL_LAYERS_MASK;
  return v | 0;
}

/** 掩码是否包含层 */
export function maskHasLayer(mask: number, index: number): boolean {
  return (mask & (1 << index)) !== 0;
}

/** 掩码置位/清除层（返回新掩码） */
export function maskWithLayer(mask: number, index: number, on: boolean): number {
  return on ? mask | (1 << index) : mask & ~(1 << index);
}

/** 掩码快捷档：全选 */
export const MASK_EVERYTHING_LABEL = "Everything";
/** 掩码快捷档：全不选 */
export const MASK_NOTHING_LABEL = "Nothing";

/** 掩码摘要文本（检查器 Culling Mask 控件回显）：Everything / Nothing / 逗号分隔层名 */
export function cullingMaskLabel(table: LayerTable, mask: number): string {
  if (mask === ALL_LAYERS_MASK) return MASK_EVERYTHING_LABEL;
  if (mask === 0) return MASK_NOTHING_LABEL;
  const names = definedLayerIndices(table)
    .filter((i) => maskHasLayer(mask, i))
    .map((i) => layerNameAt(table, i));
  // 含未定义层位的掩码：逐个补 "Layer N" 兜底显示
  let extra = 0;
  for (let i = 0; i < MAX_LAYERS; i++) {
    if (maskHasLayer(mask, i) && !isLayerDefined(table, i)) extra++;
  }
  if (extra > 0) names.push(`+${extra}`);
  return names.length ? names.join(", ") : MASK_NOTHING_LABEL;
}

/** 任意来源 → 收敛的项目标签列表（trim / 去空 / 去重，保持顺序；不含内置 Untagged） */
export function parseTagList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
