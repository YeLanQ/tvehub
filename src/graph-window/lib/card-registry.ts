// ---------------------------------------------------------------------------
// 图卡片注册表（画布插槽的单一路由点）：
// 图节点类型 → Vue Flow 节点插槽名。三级查找：显式类型键 → 类别 → 通用卡。
// 内置类别沿用专属卡片（原型/匹配/容器等带定制交互）；注入模块的新类别与
// 未装载模块（unresolved）统一落通用卡（注册表驱动端口/字段渲染，零 UI 成本）。
//
// 插槽注册：registerCardSlot(key, slot, scope)——type 精确键优先于 category；
// 画布模板需存在同名 #node-<slot> 插槽。
// ---------------------------------------------------------------------------

import { nodeTypeDef, type GNode, type GNodeCategory } from "../../framework/graph";

/** 通用卡插槽（注册表驱动渲染；unresolved 节点也走此卡并显示缺失态） */
export const GRAPH_GENERIC_SLOT = "gcard";

const TYPE_SLOTS = new Map<string, string>();
const CATEGORY_SLOTS = new Map<GNodeCategory, string>();

/** 类别 → 插槽（内置映射；registerCardSlot 可覆盖/扩展） */
for (const [cat, slot] of Object.entries({
  entity: GRAPH_GENERIC_SLOT,
  event: "gevent",
  logic: "glogic",
  driver: "gop",
  op: "gop",
  flow: "gflow",
  math: "gmath",
  variable: "gvar",
  custom: "gcustom",
} as Record<GNodeCategory, string>) as [GNodeCategory, string][]) {
  CATEGORY_SLOTS.set(cat, slot);
}

/** 实体类的两个特化卡（entity 类别缺省落通用卡） */
TYPE_SLOTS.set("entity.proto", "gproto");
TYPE_SLOTS.set("entity.match", "gmatch");

/** 注册插槽映射：scope=type 按精确类型键 / scope=category 按类别 */
export function registerCardSlot(key: string, slot: string, scope: "type" | "category" = "type"): void {
  if (scope === "type") TYPE_SLOTS.set(key, slot);
  else CATEGORY_SLOTS.set(key as GNodeCategory, slot);
}

/** 图节点 → 画布插槽名 */
export function cardSlotFor(n: GNode): string {
  if (n.unresolved) return GRAPH_GENERIC_SLOT; // 通用卡内部渲染缺失模块态
  const byType = TYPE_SLOTS.get(n.type);
  if (byType) return byType;
  const def = nodeTypeDef(n.type);
  if (def) {
    const byCat = CATEGORY_SLOTS.get(def.category);
    if (byCat && byCat !== GRAPH_GENERIC_SLOT) return byCat;
  }
  return GRAPH_GENERIC_SLOT;
}
