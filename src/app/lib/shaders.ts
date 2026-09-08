// ---------------------------------------------------------------------------
// 着色器资产操作（应用层薄封装）：读取走后端命令（.shader 格式所有权在 Rust：
// internal/项目路由、ShaderLab 源码解析都在后端完成），本文件只做类型桥接。
// 着色器类型在创建时固定（shader_write 仅用于创建），此后不再提供改写。
// ---------------------------------------------------------------------------

import { api } from "../../lib/api";
import { normalizeShaderKind, type ShaderDoc } from "../../framework/material";

/** 按引用读取并解析着色器文档（后端 shader_read；source 为 ShaderLab 源码全文；
 * 失败/缺失返回 null） */
export async function loadShaderDoc(root: string | null, rel: string): Promise<ShaderDoc | null> {
  if (!root) return null;
  try {
    const doc = await api.shaderRead(root, rel);
    return doc
      ? { name: doc.name, kind: normalizeShaderKind(doc.kind), source: doc.source ?? "" }
      : null;
  } catch {
    return null;
  }
}

/** 按引用解析着色器渲染分支 kind（失败回退 "physical"） */
export async function loadShaderKind(root: string | null, rel: string): Promise<ShaderDoc["kind"]> {
  const doc = await loadShaderDoc(root, rel);
  return doc?.kind ?? "physical";
}
