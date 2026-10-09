// 地形（terrainNode）构建：播放侧适配层。
// 几何/配色/简化/DEM 解码等纯算法**单源自编辑器 framework/terrain**（经
// runtime 构建链打进本产物），本文件只保留播放端装配差异：
// - 场景 JSON 宽松视图的收敛（parseTerrainSettings）与材质图层覆盖；
// - 雕刻层/DEM 数据源解码与叠加（sculpt/dem）；
// - chunk 拆分（视锥剔除）与 MeshStandardMaterial 装配；
// - splatmap 异步重烘焙（applyTerrainSplatmaps）与脚本贴地采样 API
//   （createTerrains：sampleHeight/sampleSlope/settingsOf）。
// 算法语义参考 three.js 示例 TerrainGenerator.js；改参数/算法去
// framework/terrain/generate.ts，两端（编辑器视口/播放产物）同源生效。
import * as THREE from "../core/three.module.min.js";
import { num } from "../core/utils";
import { resourceLoader } from "./resource";
import { parseTerrainSettings, type TerrainSettings } from "../../framework/terrain/types";
import {
  bakeColorTexture,
  buildTerrain,
  sampleTerrainHeight,
  splitTerrainGeometry,
  type SplatmapData,
  type TerrainBuild,
} from "../../framework/terrain/generate";
import { decodeSculptData } from "../../framework/terrain/sculpt";
import { demBaseHeights, parseTerrainDem } from "../../framework/terrain/dem";
import type { NodeJson } from "./node-json";
import type { SceneTerrainEntry } from "./nodes";

// ---------------------------------------------------------------------------
// 类型（JSON 宽松视图 + 材质绑定）
// ---------------------------------------------------------------------------

/** 地形材质图层 JSON（materialSettings.layers[n]；color 为 sRGB hex） */
interface TerrainLayerJson {
  color?: number;
  [key: string]: unknown;
}

/** 地形材质绑定 JSON（materialSettings：图层颜色覆盖 + splatmap 重烘焙 + PBR 参数） */
interface TerrainMaterialSettingsJson {
  layers?: TerrainLayerJson[];
  /** splatmap 图片 rel（存在则异步重烘焙颜色纹理） */
  splatmap?: string;
  metalness?: number;
  roughness?: number;
  [key: string]: unknown;
}

/** DEM 数据源 JSON（dem.data = base64 Float32 归一化高度；gridN 网格边长） */
interface DemJson {
  data?: unknown;
  gridN?: unknown;
  [key: string]: unknown;
}

/** 雕刻偏移层 JSON（sculpt.data = base64 Float32；gridN 须与烘焙网格一致） */
interface SculptJson {
  data?: unknown;
  gridN?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 播放端装配
// ---------------------------------------------------------------------------

/** 材质绑定图层缺省色（与编辑器地形材质缺省一致：草/岩/雪 + 第 4 层白） */
const FALLBACK_LAYER_COLORS: [number, number, number, number] = [0x6e7253, 0x736a5f, 0xe9ecf0, 0xffffff];

/** 材质绑定 JSON → 地形设置（图层颜色覆盖）+ 程序化 splatmap 输入 */
function applyMaterialSettings(
  settings: TerrainSettings,
  ms: TerrainMaterialSettingsJson | null,
): { settings: TerrainSettings; splatmap: SplatmapData | null } {
  if (!ms) return { settings, splatmap: null };
  const s: TerrainSettings = {
    ...settings,
    grassColor: ms.layers?.[0]?.color ?? settings.grassColor,
    rockColor: ms.layers?.[1]?.color ?? settings.rockColor,
    snowColor: ms.layers?.[2]?.color ?? settings.snowColor,
  };
  // 材质已绑定：传程序化 splatmap（data=null → 按海拔/坡度 4 层混合）
  const splatmap: SplatmapData = {
    data: null,
    width: 0,
    height: 0,
    layerColors: [
      ms.layers?.[0]?.color ?? FALLBACK_LAYER_COLORS[0],
      ms.layers?.[1]?.color ?? FALLBACK_LAYER_COLORS[1],
      ms.layers?.[2]?.color ?? FALLBACK_LAYER_COLORS[2],
      ms.layers?.[3]?.color ?? FALLBACK_LAYER_COLORS[3],
    ],
  };
  return { settings: s, splatmap };
}

/** 雕刻偏移层：节点 sculpt JSON（data/gridN）→ Float32（网格规模一致才叠加） */
function sculptLayerOf(json: NodeJson, gridSize: number): Float32Array | null {
  const sculptJson = json.sculpt as SculptJson | null | undefined;
  if (!sculptJson || typeof sculptJson.data !== "string" || sculptJson.gridN !== gridSize) return null;
  const offsets = decodeSculptData(sculptJson.data);
  return offsets && offsets.length === gridSize * gridSize ? offsets : null;
}

/** DEM 数据源：节点 dem JSON → 基准高度（损坏返回 null → 回退程序化） */
function demBaseOf(dem: DemJson | null | undefined, heightScale: number, targetN: number): Float32Array | null {
  const parsed = parseTerrainDem(dem);
  return parsed ? demBaseHeights(parsed, heightScale, targetN) : null;
}

/**
 * 构建 terrainNode 的渲染网格：烘焙高度场几何 + 颜色纹理材质，拆分 4×4 chunk
 * 供视锥剔除（每 chunk 独立 boundingBox，three.js 自动剔除不可见 chunk）。
 * 返回 { obj, data, settings }；obj 为名为 __terrainMesh 的 Group（含 chunk 子网格）。
 */
export function createTerrain(json: NodeJson): { obj: THREE.Group; data: TerrainBuild; settings: TerrainSettings } {
  const settings = parseTerrainSettings(json.terrain);
  // 地形材质绑定：用材质图层颜色覆盖地形内置配色 + PBR 参数
  //（materialSettings 为编辑器材质绑定 JSON，结构断言收窄 layers/splatmap/PBR 字段）
  const ms = (json.materialSettings ?? null) as TerrainMaterialSettingsJson | null;
  const { settings: ts, splatmap } = applyMaterialSettings(settings, ms);
  const base = demBaseOf(json.dem as DemJson | null | undefined, settings.heightScale, settings.segments + 1);
  const data = buildTerrain(ts, splatmap, sculptLayerOf(json, settings.segments + 1), base ?? undefined);
  // 分块数随尺寸自适应（与编辑器 SceneSynchronizer 同规则）：≥800 用 8×8
  const chunkGeoms = splitTerrainGeometry(data.geometry, data.size, data.size >= 800 ? 8 : 4);
  data.geometry.dispose();

  const matMetalness = ms ? (ms.metalness ?? 0) : 0;
  const matRoughness = ms ? (ms.roughness ?? 0.95) : 0.95;
  const material = new THREE.MeshStandardMaterial({ map: data.colorTexture, metalness: matMetalness, roughness: matRoughness });
  const group = new THREE.Group();
  group.name = "__terrainMesh";
  for (const geom of chunkGeoms) {
    const chunkMesh = new THREE.Mesh(geom, material);
    chunkMesh.castShadow = true;
    chunkMesh.receiveShadow = true;
    chunkMesh.userData.terrainHeights = data.heights;
    chunkMesh.userData.terrainGridSize = data.gridSize;
    chunkMesh.userData.terrainSize = data.size;
    group.add(chunkMesh);
  }
  group.userData.terrainMinY = data.minY;
  group.userData.terrainMaxY = data.maxY;
  return { obj: group, data, settings: ts };
}

/**
 * 异步回填地形 splatmap：对绑定了地形材质且材质引用了 splatmap 的地形节点，
 * 加载 splatmap 图片像素数据，按 RGBA 权重重新烘焙颜色纹理并替换材质 map。
 * 与 applyMeshTextures 同一异步 pass（buildSceneTree 后执行）。
 * terrains = buildSceneTree 收集的 [{ json, obj, data, settings }]。
 */
export async function applyTerrainSplatmaps(terrains: SceneTerrainEntry[]): Promise<void> {
  await Promise.all(
    terrains.map(async (entry) => {
      // materialSettings 为编辑器材质绑定 JSON（结构断言收窄 splatmap/layers 字段）
      const ms = entry.json?.materialSettings as TerrainMaterialSettingsJson | undefined;
      const rel = ms?.splatmap;
      if (!rel || typeof rel !== "string") return;

      let bmp: ImageBitmap | undefined;
      try {
        bmp = await resourceLoader.loadImageBitmap(rel, false);
      } catch {
        return;
      }
      if (!bmp) return;

      const canvas = document.createElement("canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx2d = canvas.getContext("2d");
      if (!ctx2d) return;
      ctx2d.drawImage(bmp, 0, 0);
      const imgData = ctx2d.getImageData(0, 0, bmp.width, bmp.height);

      const splatmap: SplatmapData = {
        data: new Uint8Array(imgData.data.buffer.slice(0)),
        width: bmp.width,
        height: bmp.height,
        layerColors: [
          ms.layers?.[0]?.color ?? FALLBACK_LAYER_COLORS[0],
          ms.layers?.[1]?.color ?? FALLBACK_LAYER_COLORS[1],
          ms.layers?.[2]?.color ?? FALLBACK_LAYER_COLORS[2],
          ms.layers?.[3]?.color ?? FALLBACK_LAYER_COLORS[3],
        ],
      };

      // buildSceneTree 地形条目 data/settings 由 createTerrain 产出（SceneTerrainEntry 声明为 unknown）
      const d = entry.data as TerrainBuild;
      const p = entry.settings as TerrainSettings;
      const newTex = bakeColorTexture(d.heights, d.gridSize, p, d.minY, d.maxY, splatmap);

      const terrainGroup = entry.obj.children.find((c) => c.name === "__terrainMesh");
      if (!terrainGroup) return;
      // chunk 子网格为 Mesh（splitTerrainGeometry 产物挂 MeshStandardMaterial）
      const mat = (terrainGroup.children[0] as THREE.Mesh | undefined)?.material as THREE.MeshStandardMaterial | undefined;
      if (!mat) return;
      if (mat.map) mat.map.dispose();
      mat.map = newTex;
      mat.needsUpdate = true;
    }),
  );
}

/** 地表平坦度（1 = 平地 → 0 = 崖壁；有限差分；SDK sampleSlope 的实现体） */
function sampleSlopeOf(data: TerrainBuild, x: number, z: number): number {
  const e = data.size / data.segments;
  const hx = sampleTerrainHeight(data, x + e, z) - sampleTerrainHeight(data, x - e, z);
  const hz = sampleTerrainHeight(data, x, z + e) - sampleTerrainHeight(data, x, z - e);
  return (2 * e) / Math.sqrt(hx * hx + 4 * e * e + hz * hz);
}

/**
 * 地形运行时系统（贴地采样 API；脚本经 TerrainNode SDK / engine 寻址）。
 * entries = buildSceneTree 收集的 [{ json, obj, data }]。
 */
export function createTerrains(entries: SceneTerrainEntry[]): {
  sampleHeight(nodeId: string, x: unknown, z: unknown): number;
  sampleSlope(nodeId: string, x: unknown, z: unknown): number;
  settingsOf(nodeId: string): TerrainSettings | null;
} {
  const byId = new Map<string, SceneTerrainEntry>();
  for (const e of entries) {
    const id = typeof e.json?.id === "string" ? e.json.id : "";
    if (id) byId.set(id, e);
  }
  return {
    /** 世界高度采样（节点本地 x/z；节点仅平移时即世界坐标） */
    sampleHeight(nodeId: string, x: unknown, z: unknown): number {
      const e = byId.get(nodeId);
      return e ? sampleTerrainHeight(e.data as TerrainBuild, num(x, 0), num(z, 0)) : 0;
    },
    /** 地表平坦度采样（1 = 平地 → 0 = 崖壁） */
    sampleSlope(nodeId: string, x: unknown, z: unknown): number {
      const e = byId.get(nodeId);
      return e ? sampleSlopeOf(e.data as TerrainBuild, num(x, 0), num(z, 0)) : 1;
    },
    settingsOf(nodeId: string): TerrainSettings | null {
      const e = byId.get(nodeId);
      // settings 由 createTerrain 的 parseTerrainSettings 收敛（SceneTerrainEntry 声明为 unknown）
      return e ? { ...(e.settings as TerrainSettings) } : null;
    },
  };
}
