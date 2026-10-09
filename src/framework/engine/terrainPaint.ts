// ---------------------------------------------------------------------------
// 地形绘制/雕刻会话编排（TerrainPaintController 的引擎侧接线）：
// 会话开启（按工具分支取工作缓冲/基准高度）、雕刻提交（节点 sculpt 字段 +
// 可撤销补丁）、splatmap 落盘后的缓存失效重载。
// ---------------------------------------------------------------------------
import type { EditorEngine } from "./EditorEngine";
import { TerrainNode } from "../prototype/derived/Primitives";
import type { JsonRecord } from "../prototype/types";
import { bakeTerrainHeights, decodeSculptData, demBaseHeights, encodeSculptData } from "../terrain";
import type { SplatBuffer } from "../terrain/paint";
import type { TerrainToolBrush } from "./modules/TerrainPaintController";

/**
 * 开始地形绘制/雕刻（按当前工具分支）：
 * - paint（绘制材质层）：要求选中地形已绑定材质并生成 Splatmap，工作缓冲取自
 *   splatmap 缓存（未加载时等待解码）；
 * - sculpt（雕刻地形）：只需选中地形；基准高度按设置程序化烘焙，工作偏移层
 *   从节点 sculpt 解码（网格规模一致时）。
 */
export async function beginTerrainPaint(engine: EditorEngine): Promise<{ ok: boolean; reason?: string }> {
  if (engine.previewMode) return { ok: false, reason: "预览模式下不可绘制" };
  const node = engine.getSelectedNode();
  if (!(node instanceof TerrainNode)) return { ok: false, reason: "请先选中地形节点" };
  const obj = engine.synchronizer.getObjectMap().get(node.id);
  if (!obj) return { ok: false, reason: "地形尚未就绪" };

  if (engine.paintBrush.tool === "paint") {
    const splatRel = node.materialSettings?.splatmap ?? "";
    if (!node.materialAsset || !node.materialSettings || !splatRel) {
      return { ok: false, reason: "请先绑定地形材质并生成 Splatmap（检查器 → Terrain Material），或切换到雕刻工具" };
    }
    const data = await engine.synchronizer.ensureSplatmapData(splatRel);
    if (!data) return { ok: false, reason: "Splatmap 读取失败" };
    engine.terrainPaint.begin({
      kind: "paint",
      node,
      terrainObj: obj,
      buffer: { data: new Uint8ClampedArray(data.data), width: data.width, height: data.height },
      splatRel,
    });
    return { ok: true };
  }

  // sculpt：基准高度按数据源烘焙（DEM 优先；每次会话一次；segments 上限 256 可接受）
  const base = node.dem
    ? { heights: demBaseHeights(node.dem, node.terrain.heightScale, node.terrain.segments + 1) ?? bakeTerrainHeights(node.terrain).heights, gridSize: node.terrain.segments + 1 }
    : bakeTerrainHeights(node.terrain);
  const offsets = new Float32Array(base.gridSize * base.gridSize);
  if (node.sculpt && node.sculpt.gridN === base.gridSize) {
    const prev = decodeSculptData(node.sculpt.data);
    if (prev && prev.length === offsets.length) offsets.set(prev);
  }
  engine.terrainPaint.begin({
    kind: "sculpt",
    node,
    terrainObj: obj,
    base: base.heights,
    offsets,
    gridN: base.gridSize,
  });
  return { ok: true };
}

/** 雕刻提交：工作偏移层写入节点 sculpt 字段并走节点补丁（可撤销） */
export function commitTerrainSculpt(engine: EditorEngine): void {
  const session = engine.terrainPaint?.getSession();
  if (!session || session.kind !== "sculpt") return;
  const node = session.node;
  const before = node.toJSON() as JsonRecord;
  node.sculpt = { gridN: session.gridN, data: encodeSculptData(session.offsets) };
  const after = node.toJSON() as JsonRecord;
  engine.patchNode(node.id, before, after, "雕刻地形");
}

/**
 * 地形绘制落盘完成后的失效重载（应用层写完 PNG 调用）：
 * 清纹理缓存与 splatmap 像素缓存 + 推进内容纪元 → 引用地形的节点按新数据
 * 只重烤颜色纹理（几何不动）。
 */
export function invalidateTerrainSplatmap(engine: EditorEngine, rel: string): void {
  if (!rel) return;
  for (const key of [...engine.textureCache.keys()]) {
    if (key.endsWith(`|${rel}`)) engine.textureCache.delete(key);
  }
  engine.synchronizer.bumpSplatmapEpoch();
  engine.synchronizer.clearSplatCache(rel);
  for (const node of engine.graph.all()) {
    if (node instanceof TerrainNode && node.materialSettings?.splatmap === rel) {
      const obj = engine.synchronizer.getObjectMap().get(node.id);
      if (obj) engine.synchronizer.refreshNodeFor(node);
    }
  }
}

/** 轻量缓存失效：只清纹理加载缓存（防止旧缓存），不刷新地形（绘制实时预览已更新视觉） */
export function invalidateTerrainSplatmapCache(engine: EditorEngine, rel: string): void {
  if (!rel) return;
  for (const key of [...engine.textureCache.keys()]) {
    if (key.endsWith(`|${rel}`)) engine.textureCache.delete(key);
  }
}

/** 应用层注入的绘制落盘（编码 PNG → 写资产 → 调 invalidateTerrainSplatmap） */
export function setTerrainPaintCommitHandler(engine: EditorEngine, handler: (buffer: SplatBuffer, rel: string) => void): void {
  engine.terrainPaintCommitHandler = handler;
}

/** 当前工具笔刷参数合并（应用层经 setTerrainPaintBrush 注入 UI 状态） */
export function setTerrainPaintBrush(engine: EditorEngine, brush: Partial<TerrainToolBrush>): void {
  engine.paintBrush = { ...engine.paintBrush, ...brush };
}
