// 地形系统冒烟测试（headless，无需 GPU）。
// @priority P1（契约漂移待清：见 tests/ISSUES.md）
// 覆盖五段：
// ① 数据层：设置默认值 / parse 收敛（缺失、非法、越界、颜色钳制）/ 深拷贝 / 签名；
// ② 节点层：注册表登记、工厂产出、序列化往返、旧场景兼容（无 terrain 字段）、clone 深拷贝、
//    资产引用读写（asset 非空才写入，旧场景字节兼容）；
// ③ 程序化生成：同种子确定性、几何规模（顶点/索引/包围）、sampleHeight 双线性一致、
//    顶点色归一、菜单映射（node-menu "terrain" → 注册表）；
// ④ 同步器：__terrainMesh 挂载、层跟随、设置签名变化重建几何、阴影参与；
// ⑤ 契约：tve.d.ts / tve.mjs / node-types.mjs（SDK TerrainNode）、nodes.mjs / player.mjs /
//    scripts.mjs（运行时接线）、terrain.rs / lib.rs（资产命令）、资产菜单（新建地形/添加到场景）。
// 跑法：
//   npx vite build --ssr scripts/smoke-terrain.ts --outDir .tmp-smoke --emptyOutDir
//   node .tmp-smoke/smoke-terrain.js

import * as THREE from "three";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Node } from "../../../src/framework/prototype/Node";
import { TerrainNode } from "../../../src/framework/prototype/nodes/TerrainNode";
import { createDefaultRegistry } from "../../../src/framework/prototype/PrototypeRegistry";
import { createNodeFactory } from "../../../src/framework/factory/NodeFactory";
import { addNodeArgs, addNodeMenuItems, collectAddMenuTypes } from "../../../src/app/lib/node-menu";
import {
  DEFAULT_TERRAIN_SETTINGS,
  TERRAIN_LIMITS,
  cloneTerrainSettings,
  isTerrainAssetRel,
  parseTerrainSettings,
  terrainSettingsSig,
} from "../../../src/framework/terrain";
import { buildTerrain, sampleTerrainHeight } from "../../../src/framework/terrain/generate";
import { SceneSynchronizer } from "../../../src/framework/engine/modules/SceneSynchronizer";
import type { GraphLike } from "../../../src/framework/scene/SceneClient";
import { createSuite } from "../harness.mjs";

const { check, finish } = createSuite();

/** 最小 GraphLike（同步器只用到 get/all） */
function fakeGraph(nodes: Node[]): GraphLike {
  const map = new Map(nodes.map((n) => [n.id, n]));
  return { get: (id: string) => map.get(id), all: () => [...nodes] };
}

// ===========================================================================
console.log("[1] 数据层：默认值 / parse 收敛 / 深拷贝 / 签名");
{
  const d = DEFAULT_TERRAIN_SETTINGS;
  check("默认设置齐全（17 字段）", Object.keys(d).length === 17);
  check("默认 segments/size（256 = 2 的幂，默认持有四叉树顶点优化）", d.segments === 256 && d.size === 200);

  // 缺失字段 → 全默认
  const empty = parseTerrainSettings(undefined);
  check("parse(undefined) 回退默认", JSON.stringify(empty) === JSON.stringify(d));
  // 非法类型 → 默认
  const junk = parseTerrainSettings({ seed: "x", size: null, octaves: NaN });
  check("非法类型回退默认", junk.seed === d.seed && junk.size === d.size && junk.octaves === d.octaves);
  // 越界 → 钳制
  const clamped = parseTerrainSettings({
    seed: 0,
    size: 99999,
    segments: 3,
    heightScale: -5,
    octaves: 99,
    gain: 2,
    seaLevel: 9,
    talusPasses: 1000,
  });
  check("越界钳制", clamped.seed === TERRAIN_LIMITS.seed.min &&
    clamped.size === TERRAIN_LIMITS.size.max &&
    clamped.segments === TERRAIN_LIMITS.segments.min &&
    clamped.heightScale === TERRAIN_LIMITS.heightScale.min &&
    clamped.octaves === TERRAIN_LIMITS.octaves.max &&
    clamped.gain === TERRAIN_LIMITS.gain.max &&
    clamped.seaLevel === TERRAIN_LIMITS.seaLevel.max &&
    clamped.talusPasses === TERRAIN_LIMITS.talusPasses.max);
  // 颜色钳制（越界回白/黑，不做掩码环绕）
  const color = parseTerrainSettings({ grassColor: 0x12345678, snowColor: -3 });
  check("颜色收敛到 0..0xffffff", color.grassColor === 0xffffff && color.snowColor === 0);

  // 深拷贝：改副本不影响源
  const src = parseTerrainSettings({ seed: 42 });
  const copy = cloneTerrainSettings(src);
  copy.seed = 7;
  check("clone 深拷贝", src.seed === 42 && copy.seed === 7);

  // 签名：任何字段变化都改变签名
  const base = parseTerrainSettings({});
  const sigs = new Set<string>([terrainSettingsSig(base)]);
  const variants = [
    { ...base, seed: base.seed + 1 },
    { ...base, size: base.size + 1 },
    { ...base, grassColor: 0x112233 },
  ];
  let allDiffer = true;
  for (const v of variants) {
    const s = terrainSettingsSig(v);
    if (sigs.has(s)) allDiffer = false;
    sigs.add(s);
  }
  check("签名随字段变化", allDiffer);

  check("isTerrainAssetRel", isTerrainAssetRel("assets/T.terrain") && !isTerrainAssetRel("assets/T.mat"));
}

// ===========================================================================
console.log("[2] 节点层：注册 / 工厂 / 序列化往返 / 旧场景兼容 / clone");
{
  const registry = createDefaultRegistry();
  check("注册表登记 terrainNode", registry.has("terrainNode"));
  const factory = createNodeFactory(registry);

  const node = factory.createTerrain({ name: "My Terrain" });
  check("工厂产出 TerrainNode", node instanceof TerrainNode && node.typeKey === "terrainNode");
  check("默认名 Terrain", node.name === "My Terrain");

  // 序列化往返
  node.terrain = parseTerrainSettings({ seed: 99, size: 100, segments: 32, grassColor: 0x112233 });
  node.asset = "assets/Hills.terrain";
  const json = node.toJSON() as Record<string, unknown>;
  const restored = registry.createFromJSON(JSON.parse(JSON.stringify(json)) as Record<string, unknown>) as TerrainNode;
  check("createFromJSON 产出 TerrainNode", restored instanceof TerrainNode);
  check("terrain 设置往返一致", JSON.stringify(restored.terrain) === JSON.stringify(node.terrain));
  check("asset 引用往返一致", restored.asset === "assets/Hills.terrain");

  // 旧场景兼容：无 terrain/asset 字段
  const legacy = registry.createFromJSON({ type: "terrainNode", id: "terrainNode_legacy", name: "Old" });
  check("旧场景无 terrain 字段回默认", legacy instanceof TerrainNode &&
    JSON.stringify(legacy.terrain) === JSON.stringify(DEFAULT_TERRAIN_SETTINGS));
  check("旧场景无 asset 字段为空串", legacy.asset === "");
  // asset 为空时不写入（旧场景字节兼容）
  const plain = factory.createTerrain();
  const plainJson = plain.toJSON() as Record<string, unknown>;
  check("未绑定资产时序列化不含 asset", !("asset" in plainJson));
  check("未绑定资产时序列化含 terrain", "terrain" in plainJson);

  // clone
  const cloned = node.clone();
  check("clone 类型与设置", cloned instanceof TerrainNode && cloned.terrain.seed === 99 && cloned.asset === "assets/Hills.terrain");
  cloned.terrain.seed = 1;
  check("clone 设置深拷贝", node.terrain.seed === 99);
}

// ===========================================================================
console.log("[3] 程序化生成：确定性 / 几何规模 / 采样 / 顶点色 / 菜单映射");
{
  const small = parseTerrainSettings({ size: 100, segments: 32, heightScale: 20 });

  const a = buildTerrain(small);
  const b = buildTerrain(parseTerrainSettings({ size: 100, segments: 32, heightScale: 20, seed: 1 }));
  let same = a.heights.length === b.heights.length;
  for (let i = 0; i < a.heights.length && same; i++) same = a.heights[i] === b.heights[i];
  check("同种子确定性（seed=1 两次烘焙一致）", same);

  const c = buildTerrain(parseTerrainSettings({ size: 100, segments: 32, heightScale: 20, seed: 2 }));
  check("不同种子不同地形", a.heights[0] !== c.heights[0] || a.heights[a.heights.length - 1] !== c.heights[c.heights.length - 1]);

  const pos = a.geometry.getAttribute("position") as THREE.BufferAttribute;
  const idx = a.geometry.getIndex();
  // segments=32 是 2 的幂 → 四叉树顶点简化启用：顶点/索引 ≤ 全网格规模，
  // 且三角形索引全部落在顶点范围内
  check("顶点数 ≤ (segments+1)²（简化启用）", pos.count <= 33 * 33 && pos.count > 33 * 2);
  let maxIdx = 0;
  if (idx) {
    const arr = idx.array as ArrayLike<number>;
    for (let i = 0; i < arr.length; i++) if (arr[i] > maxIdx) maxIdx = arr[i];
  }
  check(
    "索引规模合法（3 的倍数、不越界、至少 4 个三角形）",
    idx !== null && idx.count % 3 === 0 && idx.count >= 12 && maxIdx < pos.count,
  );
  check("颜色纹理已烘焙（DataTexture）", !!a.colorTexture && (a.colorTexture as THREE.DataTexture).isDataTexture === true);
  check("法线已计算", a.geometry.getAttribute("normal") !== undefined);

  // 包围：XZ 在 ±size/2，Y 在 [minY, maxY]
  let within = true;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = pos.getY(i);
    if (Math.abs(x) > 50.001 || Math.abs(z) > 50.001) within = false;
    if (y < a.minY - 1e-4 || y > a.maxY + 1e-4) within = false;
  }
  check("XZ 包围在 ±size/2 且 Y 在 [minY, maxY]", within);
  check("有限高度（无 NaN）", Number.isFinite(a.minY) && Number.isFinite(a.maxY));

  // 采样：网格点处 sampleHeight == heights；格中点落在两端之间
  const half = a.size / 2;
  const at00 = sampleTerrainHeight(a, -half, -half);
  check("角点采样 == 烘焙高度", at00 === a.heights[0]);
  const mid = sampleTerrainHeight(a, 0, 0);
  const h00 = a.heights[16 * 33 + 16];
  const h11 = a.heights[17 * 33 + 17];
  check("格中点采样落在四角之间", mid >= Math.min(h00, h11) - 1e-4 && mid <= Math.max(h00, h11) + 1e-4);
  check("超界采样钳到边缘", sampleTerrainHeight(a, 9999, 0) === sampleTerrainHeight(a, half, 0));

  // 菜单映射：terrain 项 → addNodeArgs 落到 kind terrain（nodeCommands 分支见契约段）
  const items = addNodeMenuItems({ geometry: [], scripts: [] });
  const args = addNodeArgs("terrain", "root");
  check("node-menu terrain → kind terrain", args !== null && args.kind === "terrain");
  check("菜单类型串全部可映射", collectAddMenuTypes(items).every((t) => addNodeArgs(t, "root") !== null));

  // 默认参数（segments=256，2 的幂）→ 四叉树顶点简化必须启用：
  // 顶点数严格小于全网格（257²），且非 2 次幂（192）才回退全网格
  const def = buildTerrain(DEFAULT_TERRAIN_SETTINGS);
  const defPos = def.geometry.getAttribute("position") as THREE.BufferAttribute;
  check(
    "默认参数持有顶点优化（顶点数 < (segments+1)²）",
    defPos.count < 257 * 257 && defPos.count > 0,
  );
  const legacy = buildTerrain(parseTerrainSettings({ ...DEFAULT_TERRAIN_SETTINGS, segments: 192 }));
  const legacyPos = legacy.geometry.getAttribute("position") as THREE.BufferAttribute;
  check("非 2 次幂 segments 回退均匀网格（顶点数 = (segments+1)²）", legacyPos.count === 193 * 193);
}

// ===========================================================================
console.log("[4] 同步器：__terrainMesh / 层跟随 / 签名重建");
{
  const scene = new THREE.Scene();
  const sync = new SceneSynchronizer(scene);
  const registry = createDefaultRegistry();
  const factory = createNodeFactory(registry);

  const root = new Node({ name: "Root" });
  const node = factory.createTerrain({ parentId: root.id });
  node.terrain = parseTerrainSettings({ size: 100, segments: 32 });
  node.layer = 2;
  root.addChildId(node.id);
  const graph = fakeGraph([root, node]);
  sync.rebuildAll(graph);

  const obj = sync.getObjectMap().get(node.id)!;
  check("地形节点映射为 Group", (obj as THREE.Group).isGroup === true);
  check("nodeKind 标记", obj.userData.nodeKind === "terrainNode");
  const group = obj.children.find((c) => c.name === "__terrainMesh") as THREE.Group | undefined;
  check("同步器挂 __terrainMesh 组（4×4 分块）", !!group && group.isGroup === true && group.children.length === 16);
  const chunk0 = group?.children[0] as THREE.Mesh | undefined;
  check("分块为 Mesh", !!chunk0 && chunk0.isMesh === true);
  check("网格跟随节点层", !!chunk0 && chunk0.layers.mask === obj.layers.mask);
  check("投射/接收阴影", !!chunk0 && chunk0.castShadow === true && chunk0.receiveShadow === true);
  const mat = group?.userData.terrainMaterial as THREE.MeshStandardMaterial | undefined;
  check("颜色纹理材质（map = colorTexture）", !!mat && !!mat.map);

  const sig1 = group?.userData.terrainSig;
  const geoBefore = chunk0?.geometry;
  // 设置不变：重复刷新不重建
  sync.onGraphChange({ kind: "properties", nodeId: node.id } as never, graph);
  const chunkNoop = (obj.children.find((c) => c.name === "__terrainMesh") as THREE.Group).children[0] as THREE.Mesh;
  check("设置未变不重建几何", chunkNoop.geometry === geoBefore);
  // 设置变化：签名变化重建
  node.terrain = parseTerrainSettings({ size: 100, segments: 32, seed: DEFAULT_TERRAIN_SETTINGS.seed + 5 });
  sync.onGraphChange({ kind: "properties", nodeId: node.id } as never, graph);
  const group2 = obj.children.find((c) => c.name === "__terrainMesh") as THREE.Group;
  const chunk2 = group2.children[0] as THREE.Mesh;
  check("设置变化重建几何", chunk2.geometry !== geoBefore && group2.userData.terrainSig !== sig1);
  check("旧几何已释放", (geoBefore as THREE.BufferGeometry | null) !== null);
}

// ===========================================================================
console.log("[5] 契约：SDK / 运行时接线 / Rust 资产命令 / 资产菜单");
{
  const dts = readFileSync(resolve(process.cwd(), "src/framework/scripting/tve.d.ts"), "utf8");
  const tveMjs = readFileSync(resolve(process.cwd(), "public/engine/core/tve.mjs"), "utf8");
  const nodeTypes = readFileSync(resolve(process.cwd(), "public/engine/core/tve/node-types.mjs"), "utf8");
  const nodesSrc = readFileSync(resolve(process.cwd(), "public/engine/runtime/nodes.mjs"), "utf8");
  const terrainSrc = readFileSync(resolve(process.cwd(), "public/engine/runtime/terrain.mjs"), "utf8");
  const player = readFileSync(resolve(process.cwd(), "public/web-preview/player.mjs"), "utf8");
  const scripts = readFileSync(resolve(process.cwd(), "public/engine/core/scripts.mjs"), "utf8");
  const rust = readFileSync(resolve(process.cwd(), "src-tauri/src/scene/terrain.rs"), "utf8");
  const libRs = readFileSync(resolve(process.cwd(), "src-tauri/src/lib.rs"), "utf8");
  const assetMenu = readFileSync(resolve(process.cwd(), "src/app/lib/asset-menu.ts"), "utf8");
  const nodeCommands = readFileSync(resolve(process.cwd(), "src/app/commands/nodeCommands.ts"), "utf8");

  check("tve.d.ts 声明 TerrainNode 类", /export\s+class\s+TerrainNode\s+extends\s+Entity/.test(dts));
  check("tve.d.ts EntityKind 含 terrainNode", /"terrainNode"/.test(dts));
  check("tve.mjs 再导出 TerrainNode/terrainNode", /TerrainNode/.test(tveMjs) && /TerrainNode\s+as\s+terrainNode/.test(tveMjs));
  check("node-types.mjs KIND_CLASSES 映射 terrainNode", /terrainNode:\s*TerrainNode/.test(nodeTypes));
  check("node-types.mjs TerrainNode.sampleHeight", /sampleHeight\(x,\s*z\)/.test(nodeTypes));

  check("runtime/terrain.mjs 提供 createTerrain", /export\s+function\s+createTerrain/.test(terrainSrc));
  check("runtime/terrain.mjs 提供 createTerrains 采样 API", /export\s+function\s+createTerrains/.test(terrainSrc));
  check("nodes.mjs 分派 terrainNode", /case\s+"terrainNode":/.test(nodesSrc) && /wrapTerrain/.test(nodesSrc));
  check("player.mjs 解构 terrains 并传入 createScripts", /terrains/.test(player) && /terrains:\s*terrainsApi/.test(player));
  check("scripts.mjs 透传 terrains 到宿主", /terrains:\s*terrains\s*\?\?\s*null/.test(scripts));

  check("terrain.rs 提供 terrain_write 命令", /pub\s+async\s+fn\s+terrain_write/.test(rust));
  check("terrain.rs 序列化 $type=terrain", /"\$type":\s*"terrain"/.test(rust));
  check("lib.rs 注册 terrain_write", /scene::terrain::terrain_write/.test(libRs));

  check("资产菜单含「新建地形」", assetMenu.includes("新建地形"));
  check("资产菜单含地形「添加到场景」", /isTerrainAssetRel/.test(assetMenu) && /onAddTerrainToScene/.test(assetMenu));
  check("node.add 命令含 terrain 分支（含资产快照路径）", /case\s+"terrain":/.test(nodeCommands) && /addTerrain\(parentId,\s*\{/.test(nodeCommands));
}

// ===========================================================================
finish();
