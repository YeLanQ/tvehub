// 资产原型模板注册表（模块化 + 数据注入）：
// - 每个“资产原型”对应 public/internal/templates/ 下一个模板文件（真实文件，不内嵌代码）；
// - 需要新资产类型时：放模板文件 + 在 TEMPLATE_RELS 注册一个 kind 即可，创建流程不变；
// - loadAssetTemplate(kind, inject) 读取模板并把 {{KEY}} 占位符替换为注入数据。

import { api } from "../../lib/api";

/** 资产原型 → 内置模板相对路径（internal/…） */
const TEMPLATE_RELS: Record<string, string> = {
  // 3D 场景：空白场景（含 Root 节点），新建场景资产用
  scene: "internal/templates/EmptyScene.scene",
};

/** 取某类资产原型的内置模板路径；未注册返回 null */
export function assetTemplateRel(kind: string): string | null {
  return TEMPLATE_RELS[kind] ?? null;
}

/**
 * 读取资产原型模板并注入数据（模块化创建入口）。
 * 模板内的 {{KEY}} 占位符用 inject[KEY] 替换；未提供的占位符原样保留。
 * @param kind 已注册的资产原型类型（如 "scene"）
 * @param inject 注入数据表（键为占位符名）
 */
export async function loadAssetTemplate(
  kind: string,
  inject: Record<string, string> = {},
): Promise<string | null> {
  const rel = assetTemplateRel(kind);
  if (!rel) return null;
  try {
    const text = await api.readInternalAsset(rel);
    if (text == null) return null;
    return text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, k: string) =>
      Object.prototype.hasOwnProperty.call(inject, k) ? inject[k] ?? "" : _m,
    );
  } catch {
    return null;
  }
}
