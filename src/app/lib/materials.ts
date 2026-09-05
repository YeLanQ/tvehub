// ---------------------------------------------------------------------------
// 材质资产操作（应用层）：读取/写入 .mat 资产、内置→项目复制、旧场景迁移。
// 项目材质统一落到 <项目>/assets/materials/*.mat；内置材质位于 internal/…（只读）。
// ---------------------------------------------------------------------------

import { api } from "../../lib/api";
import { isInternalAsset } from "../../lib/internal-assets";
import {
  DEFAULT_MATERIAL_PARAMS,
  DEFAULT_MATERIAL_REL,
  MATERIAL_EXT,
  materialFileStem,
  materialParamsFrom,
  parseMaterialFile,
  serializeMaterialFile,
  type MaterialParams,
} from "../../framework/material";

/** 按引用读取 .mat 文本：internal → 内置内容；assets/… → 项目文件；失败返回 null */
export async function readMaterialText(
  root: string | null,
  rel: string,
): Promise<string | null> {
  try {
    if (isInternalAsset(rel)) return await api.readInternalAsset(rel);
    if (!root) return null;
    return await api.readText(root, rel);
  } catch {
    return null;
  }
}

/** 读取并解析材质参数（失败返回 null） */
export async function loadMaterialParams(
  root: string | null,
  rel: string,
): Promise<MaterialParams | null> {
  const text = await readMaterialText(root, rel);
  if (text == null) return null;
  const doc = parseMaterialFile(text);
  return doc ? doc.params : null;
}

/** 写入材质资产（项目 assets/…）；失败抛错由调用方处理 */
export async function saveMaterialParams(
  root: string,
  rel: string,
  name: string,
  params: MaterialParams,
): Promise<void> {
  const content = serializeMaterialFile({ name, params });
  await api.writeText(root, rel, content);
}

/** 列出项目 assets 下的材质资产相对路径（用于命名去重） */
export async function listProjectMaterialRels(root: string): Promise<string[]> {
  try {
    const entries = await api.scanAssets(root);
    return entries.filter((a) => a.kind === "mat" && a.path.startsWith("assets/")).map((a) => a.path);
  } catch {
    return [];
  }
}

/** 把引用路径的材质复制为项目材质资产（internal → assets/materials），返回新相对路径 */
export async function duplicateMaterialToProject(
  root: string,
  srcRel: string,
  preferName: string,
  taken: string[],
): Promise<string | null> {
  const params = (await loadMaterialParams(root, srcRel)) ?? { ...DEFAULT_MATERIAL_PARAMS };
  const name = sanitizeAssetStem(preferName || materialFileStem(srcRel));
  const rel = suggestMaterialRel(taken, name);
  await saveMaterialParams(root, rel, name, params);
  return rel;
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

/** 在 assets/materials 下建议一个不冲突的材质资产相对路径 */
export function suggestMaterialRel(taken: string[], stem: string): string {
  const base = sanitizeAssetStem(stem);
  const used = new Set(taken.map((r) => r.toLowerCase()));
  let name = base;
  let n = 2;
  while (used.has(`assets/materials/${name}${MATERIAL_EXT}`.toLowerCase())) {
    name = `${base} ${n++}`;
  }
  return `assets/materials/${name}${MATERIAL_EXT}`;
}

// ---------------------------------------------------------------------------
// 旧场景迁移：材质资产化之前，场景把材质参数内嵌在 meshNode 字段
// （color/metalness/roughness/emissive/wireframe）。装载时把它们“另存”为
// 项目材质资产并改写节点为 material 引用，避免画面回退成默认灰材质。
// ---------------------------------------------------------------------------

/** 从旧 meshNode JSON 提取内嵌材质参数（没有任何内嵌字段时返回 null） */
function legacyParamsFromJson(o: Record<string, unknown>): MaterialParams | null {
  const keys = ["color", "metalness", "roughness", "emissive", "wireframe"];
  if (!keys.some((k) => k in o)) return null;
  return materialParamsFrom(o);
}

function paramsEqual(a: MaterialParams, b: MaterialParams): boolean {
  return (
    a.color === b.color &&
    a.metalness === b.metalness &&
    a.roughness === b.roughness &&
    a.emissive === b.emissive &&
    a.wireframe === b.wireframe
  );
}

function walkLegacy(v: unknown, ctx: LegacyCtx): void {
  if (Array.isArray(v)) {
    for (const item of v) walkLegacy(item, ctx);
    return;
  }
  if (!v || typeof v !== "object") return;
  const o = v as Record<string, unknown>;
  if (o.type === "meshNode") {
    const legacy = typeof o.material !== "string" ? legacyParamsFromJson(o) : null;
    if (legacy) {
      if (paramsEqual(legacy, DEFAULT_MATERIAL_PARAMS)) {
        // 与内置默认一致：直接落到默认材质引用，无需生成文件
        o.material = DEFAULT_MATERIAL_REL;
      } else {
        const key = JSON.stringify([
          legacy.color,
          legacy.metalness,
          legacy.roughness,
          legacy.emissive,
          legacy.wireframe,
        ]);
        let rel = ctx.signature.get(key);
        if (!rel) {
          rel = suggestMaterialRel(ctx.taken, String(o.name ?? "Material") || "Material");
          void ctx.pending.push(
            saveMaterialParams(ctx.root, rel, sanitizeAssetStem(String(o.name ?? "Material")), legacy),
          );
          ctx.signature.set(key, rel);
          ctx.taken.push(rel);
        }
        o.material = rel;
      }
    }
  }
  // 场景文件把节点树放在 wrapper 的 root 下，节点层级用 children 数组表达
  if (Array.isArray(o.children)) walkLegacy(o.children, ctx);
  if (o.root && typeof o.root === "object") walkLegacy(o.root, ctx);
}

interface LegacyCtx {
  root: string;
  taken: string[];
  signature: Map<string, string>;
  pending: Promise<void>[];
}

/**
 * 迁移旧版场景 JSON（内嵌材质 → 材质资产引用），返回可能改写后的场景文本。
 * 无改动（新格式/无节点）时原样返回；写入失败会拒绝（由调用方决定是否回退）。
 */
export async function migrateLegacySceneText(root: string, sceneText: string): Promise<string> {
  if (!root) return sceneText;
  let json: unknown;
  try {
    json = JSON.parse(sceneText);
  } catch {
    return sceneText;
  }
  if (!json || typeof json !== "object") return sceneText;

  // 收集磁盘上已有的材质资产名，避免生成同名覆盖
  let taken: string[] = [];
  try {
    const entries = await api.scanAssets(root);
    taken = entries.filter((a) => a.kind === "mat").map((a) => a.path);
  } catch {
    /* 扫描失败也允许继续（尽量用写前不冲突名） */
  }

  const ctx: LegacyCtx = { root, taken, signature: new Map(), pending: [] };
  walkLegacy(json, ctx);
  if (ctx.pending.length === 0) return sceneText;
  await Promise.all(ctx.pending);
  return JSON.stringify(json, null, 2);
}
