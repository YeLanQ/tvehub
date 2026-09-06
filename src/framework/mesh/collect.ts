// ---------------------------------------------------------------------------
// 场景 JSON → 模型引用收集（用于装载前预取；风格对齐 material/collect）。
// ---------------------------------------------------------------------------

import { isModelAssetRel } from "./types";

/** 遍历场景 JSON（根节点或其 children）收集模型网格的模型资产引用（去重、忽略空） */
export function collectMeshModelRefs(sceneJson: unknown): string[] {
  const out = new Set<string>();
  walk(sceneJson, out);
  return [...out];
}

function walk(v: unknown, out: Set<string>): void {
  if (Array.isArray(v)) {
    for (const item of v) walk(item, out);
    return;
  }
  if (!v || typeof v !== "object") return;
  const o = v as Record<string, unknown>;
  if (
    o.type === "meshNode" &&
    o.source === "model" &&
    typeof o.model === "string" &&
    isModelAssetRel(o.model)
  ) {
    out.add(o.model);
  }
  // 场景文件把节点树放在 wrapper 的 root 下，节点层级用 children 数组表达
  if (Array.isArray(o.children)) walk(o.children, out);
  if (o.root && typeof o.root === "object") walk(o.root, out);
}
