// ---------------------------------------------------------------------------
// 材质资产操作（应用层薄封装）：读取/写入/复制全部走后端命令（.mat 格式
// 所有权在 Rust：路由 internal/项目、解析、序列化、命名去重都在后端完成）。
// 本文件只做类型桥接与命名工具。
// ---------------------------------------------------------------------------

import { api } from "../../lib/api";
import {
  DEFAULT_SHADER_REL,
  type MaterialDoc,
  type MaterialParams,
} from "../../framework/material";

/** 按引用读取并解析材质文档（后端 material_read；shader 引用已解析为渲染分支；
 * 失败/缺失返回 null） */
export async function loadMaterialDoc(root: string | null, rel: string): Promise<MaterialDoc | null> {
  if (!root) return null;
  try {
    const doc = await api.materialRead(root, rel);
    if (!doc) return null;
    return {
      name: doc.name,
      type: doc.materialType,
      shader: doc.shader,
      params: doc.params as unknown as MaterialParams,
    };
  } catch {
    return null;
  }
}

/** 读取并解析材质参数（失败返回 null） */
export async function loadMaterialParams(
  root: string | null,
  rel: string,
): Promise<MaterialParams | null> {
  const doc = await loadMaterialDoc(root, rel);
  return doc ? doc.params : null;
}

/** 写入材质资产（后端序列化 + 落盘 + 补 .meta）；shader 为着色器资产相对路径，
 * 失败抛错由调用方处理 */
export async function saveMaterialParams(
  root: string,
  rel: string,
  name: string,
  params: MaterialParams,
  shader: string = DEFAULT_SHADER_REL,
): Promise<void> {
  await api.materialWrite(root, rel, name, shader, params as unknown as Record<string, unknown>);
}

/** 列出项目 assets 下的材质资产相对路径（UI 展示/统计用） */
export async function listProjectMaterialRels(root: string): Promise<string[]> {
  try {
    const entries = await api.scanAssets(root);
    return entries.filter((a) => a.kind === "mat" && a.path.startsWith("assets/")).map((a) => a.path);
  } catch {
    return [];
  }
}

/** 把引用路径的材质复制为项目材质资产（internal → assets/materials），返回新相对路径。
 * 类型与参数随源文档保留；目标名去重由后端扫盘保证。 */
export async function duplicateMaterialToProject(
  root: string,
  srcRel: string,
  preferName: string,
): Promise<string | null> {
  try {
    return await api.materialDuplicate(root, srcRel, preferName);
  } catch {
    return null;
  }
}

/** 资产名规范化（去掉扩展名与非法字符；空值回退 "Material"） */
export function sanitizeAssetStem(raw: string): string {
  let s = (raw ?? "").trim().replace(/\.[^.]+$/, "");
  s = s
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim();
  return s || "Material";
}
