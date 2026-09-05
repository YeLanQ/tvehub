// ---------------------------------------------------------------------------
// 场景 JSON → 材质引用收集（用于装载前预取 / 网页预览导出材质文件）。
// ---------------------------------------------------------------------------

/** 遍历场景 JSON（根节点或其 children）收集 meshNode 的材质资产引用（去重、忽略空） */
export function collectMeshMaterialRefs(sceneJson: unknown): string[] {
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
  if (o.type === "meshNode" && typeof o.material === "string" && o.material) {
    out.add(o.material);
  }
  // 场景文件把节点树放在 wrapper 的 root 下，节点层级用 children 数组表达
  if (Array.isArray(o.children)) walk(o.children, out);
  if (o.root && typeof o.root === "object") walk(o.root, out);
}
