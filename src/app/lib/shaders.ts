// ---------------------------------------------------------------------------
// 着色器资产操作（应用层薄封装）：读取/保存走后端命令（.shader 格式所有权在
// Rust：internal/项目路由、Base/Hook/Properties 解析都在后端完成），
// 本文件只做类型桥接与缓存接线。
// 着色器创建时确定渲染分支（shader_write 按 kind 出模板）；项目内 .shader 支持
// 保存源码（shader_write_source），保存后重新解析的 Base/钩子/属性表随文档返回。
// ---------------------------------------------------------------------------

import { api } from "../../lib/api";
import {
  normalizeShaderKind,
  type ShaderDoc,
  type ShaderPropertyDef,
  type ShaderPropertyKind,
} from "../../framework/material";

/** 后端属性类型串 → 面板属性类型（未知回退 float） */
function normalizePropKind(kind: string): ShaderPropertyKind {
  switch (kind) {
    case "color":
    case "range":
    case "float":
    case "int":
    case "vector":
    case "texture":
      return kind;
    default:
      return "float";
  }
}

/** 后端 shader_read 返回形态 → ShaderDoc（Base/钩子/属性/错误逐字段收敛） */
function toShaderDoc(doc: {
  name: string;
  kind: string;
  source?: string;
  base?: string;
  include?: string;
  hooks?: { name: string; code: string }[];
  properties?: {
    key: string;
    label: string;
    kind: string;
    min?: number | null;
    max?: number | null;
    default: number | number[] | string;
  }[];
  error?: string | null;
  suggestedBase?: string;
}): ShaderDoc {
  const properties: ShaderPropertyDef[] = (doc.properties ?? []).map((p) => ({
    key: p.key,
    label: p.label || p.key,
    kind: normalizePropKind(p.kind),
    ...(typeof p.min === "number" ? { min: p.min } : {}),
    ...(typeof p.max === "number" ? { max: p.max } : {}),
    default: p.default,
  }));
  return {
    name: doc.name,
    kind: normalizeShaderKind(doc.kind),
    source: doc.source ?? "",
    base: doc.base ?? "",
    include: doc.include ?? "",
    hooks: (doc.hooks ?? []).map((h) => ({ name: h.name, code: h.code })),
    properties,
    error: doc.error ?? null,
    suggestedBase: doc.suggestedBase ?? "",
  };
}

/** 按引用读取并解析着色器文档（后端 shader_read；source 为 ShaderLab 源码全文，
 * Base 决定渲染分支、钩子为效果片段、properties 为材质面板参数；失败/缺失返回 null） */
export async function loadShaderDoc(root: string | null, rel: string): Promise<ShaderDoc | null> {
  if (!root) return null;
  try {
    const doc = await api.shaderRead(root, rel);
    return doc ? toShaderDoc(doc) : null;
  } catch {
    return null;
  }
}

/** 按引用解析着色器渲染分支（失败回退 "physical"） */
export async function loadShaderKind(root: string | null, rel: string): Promise<ShaderDoc["kind"]> {
  const doc = await loadShaderDoc(root, rel);
  return doc?.kind ?? "physical";
}

/**
 * 保存着色器源码（后端 shader_write_source：指令跟随路径 + 解析校验 + 自动补 .meta），
 * 返回重新解析后的文档（含 Base/钩子/属性表/解析错误，供编辑器与面板展示）；
 * 失败抛错由调用方提示。
 */
export async function saveShaderSource(
  root: string,
  rel: string,
  source: string,
): Promise<ShaderDoc> {
  const doc = await api.shaderWriteSource(root, rel, source);
  return toShaderDoc(doc);
}
