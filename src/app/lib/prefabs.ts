// ---------------------------------------------------------------------------
// Prefab（预制体）应用层编排：层级面板「存储为预制体 / 更新预制体」与资产面板
// 「实例化到场景」的完整流程。框架层的纯序列化/实例化在
// framework/prototype/prefab.ts；这里负责资产读写（api）、命名去重、节点数据
// 提交（node.patch 可撤销）与资产面板刷新。
//
// .prefab 资产 = 单根节点的嵌套 JSON 文档（与 .scene 的 root 同形状）；
// 实例根节点记录来源引用（Node.prefab），供「更新预制体」与检查器展示。
// ---------------------------------------------------------------------------

import { api } from "../../lib/api";
import type { Node } from "../../framework/prototype/Node";
import type { JsonRecord } from "../../framework/prototype/types";
import { dispatchCommand } from "../commands";
import { logStore } from "../stores/log";
import { getProjectStore } from "../stores/project";
import { getAssetsStore } from "../stores/assets";
import { getEditorStore } from "../stores/editor";

/** 资产名合法性（与 assetService.validateAssetName 同规则的最小校验） */
function validStem(name: string): string | null {
  const clean = name.trim();
  if (!clean || /[\\/]/.test(clean) || clean.includes("..") || clean.includes(":")) return null;
  return clean;
}

/** 目录内去重（assets/prefabs 下按现有资产列表唯一化） */
function uniquePrefabRel(base: string, assets: { path: string }[]): string {
  let name = base;
  let n = 2;
  while (assets.some((a) => a.path.toLowerCase() === `assets/prefabs/${name}.prefab`.toLowerCase())) {
    name = `${base} ${n++}`;
  }
  return `assets/prefabs/${name}.prefab`;
}

/**
 * 存储节点子树为预制体：序列化 → 写 assets/prefabs/<名>.prefab →
 * 在节点上记录来源引用（node.prefab，可撤销）。返回资产 rel（失败 null）。
 */
export async function saveNodeAsPrefab(nodeId: string, rawName: string): Promise<string | null> {
  const engine = getEditorStore().engine;
  const projectStore = getProjectStore();
  const assetsStore = getAssetsStore();
  const root = projectStore.currentPath;
  if (!root) {
    logStore.log("warn", "未打开项目，无法存储预制体");
    return null;
  }
  const clean = validStem(rawName);
  if (!clean) {
    logStore.log("warn", "无效的预制体名（不能含 / \\ : ..）");
    return null;
  }
  const node = engine.graph.get(nodeId);
  if (!node) return null;
  const doc = engine.serializeSubtree(nodeId);
  if (!doc) return null;
  const rel = uniquePrefabRel(clean, assetsStore.assets);
  try {
    await api.writeText(root, rel, JSON.stringify(doc, null, 2));
  } catch (e) {
    logStore.log("error", `写入预制体失败 ${rel}: ${e}`);
    return null;
  }
  // 来源引用落节点数据（可撤销；实例语义的锚点）
  const before = node.toJSON() as JsonRecord;
  const after = { ...before, prefab: rel } as JsonRecord;
  void dispatchCommand("node.patch", { id: nodeId, before, after, label: "记录预制体来源" });
  void assetsStore.load(root);
  logStore.log("success", `已存储预制体: ${rel}`);
  return rel;
}

/** 把节点子树写回其来源预制体资产（覆盖资产；实例数据不动） */
export async function updatePrefabFromNode(nodeId: string): Promise<boolean> {
  const engine = getEditorStore().engine;
  const projectStore = getProjectStore();
  const root = projectStore.currentPath;
  const node = engine.graph.get(nodeId);
  const rel = node?.prefab ?? "";
  if (!root || !node || !rel) {
    logStore.log("warn", "该节点不是预制体实例（无来源引用）");
    return false;
  }
  const doc = engine.serializeSubtree(nodeId);
  if (!doc) return false;
  try {
    await api.writeText(root, rel, JSON.stringify(doc, null, 2));
    logStore.log("success", `已更新预制体: ${rel}`);
    return true;
  } catch (e) {
    logStore.log("error", `更新预制体失败 ${rel}: ${e}`);
    return false;
  }
}

/** 实例化预制体资产到场景（挂到当前选中节点/根下；一次撤销） */
export async function instantiatePrefabAsset(rel: string): Promise<boolean> {
  const engine = getEditorStore().engine;
  const projectStore = getProjectStore();
  const root = projectStore.currentPath;
  if (!root) {
    logStore.log("warn", "未打开项目，无法实例化预制体");
    return false;
  }
  let text: string;
  try {
    text = await api.readText(root, rel);
  } catch (e) {
    logStore.log("error", `读取预制体失败 ${rel}: ${e}`);
    return false;
  }
  let doc: JsonRecord;
  try {
    doc = JSON.parse(text) as JsonRecord;
  } catch (e) {
    logStore.log("error", `预制体解析失败 ${rel}: ${e}`);
    return false;
  }
  if (!doc || typeof doc !== "object" || typeof doc.type !== "string") {
    logStore.log("error", `预制体格式无效（缺少根节点）: ${rel}`);
    return false;
  }
  let instance: Node | null;
  try {
    instance = engine.instantiateTree(doc, rel);
  } catch (e) {
    logStore.log("error", `预制体实例化失败 ${rel}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  if (!instance) {
    logStore.log("error", `预制体实例化失败 ${rel}（无可用父节点，请先打开场景）`);
    return false;
  }
  logStore.log("success", `已实例化预制体 ${rel} → ${instance.name}（${instance.childIds.length} 个子节点）`);
  return true;
}
