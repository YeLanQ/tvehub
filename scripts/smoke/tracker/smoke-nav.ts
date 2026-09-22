// ---------------------------------------------------------------------------
// @priority P0
// 导航系统冒烟测试（headless，无需 GPU）。
// 覆盖六段：
// ① 数据层：导航区域/代理设置默认值 / parse 收敛（缺失、非法、越界、模式收敛、
//    sourceIds 去重截断、旧 terrainId 迁移）/ 签名；
// ② 节点层：注册表登记、工厂产出、toJSON→createFromJSON 往返、旧场景兼容、clone 深拷贝；
// ③ 烘焙：确定性、SDF 数值（平地方形障碍的精确格距/障碍内负值）、坡度/高差阻挡、
//    代理半径净空、障碍过滤（高架障碍不阻挡地面）；
// ③b 网格光栅化：任意 mesh 顶面光栅化（indexed/non-indexed）、重叠取最高、
//    NaN 无表面 → 阻挡、地形 + 网格合并（脚印内取网格、外回退地形）；
// ④ 寻路与代理：直线/绕墙/不可达、终点吸附最近可行走格、视线拉直平滑、
//    NavSystem 代理推进（贴地/到达/清路径）与 SDF 滑移；
// ⑤ 契约：层级菜单（导航分组 → node.add kind nav → 注册表）、nodeCommands 分支、
//    同步器（refreshNavArea/__navMesh）、引擎（SCRIPT_NODE_BASE/addNavArea/nav.update/
//    多源 providers）、检查器（NavArea/NavAgent 卡 + Sources 多选）、统一入口动态注册；
// ⑥ 运行时导航（预览 player 装配语义）：采样源不进障碍表（回归：地形带碰撞体曾
//    被误当障碍 → 全图 blocked → 代理不动）、贴地高度按地形节点世界 Y 换算。
// 运行：pnpm smoke nav
// ---------------------------------------------------------------------------

import * as THREE from "three";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_NAV_AGENT_SETTINGS,
  DEFAULT_NAV_AREA_SETTINGS,
  NAV_AGENT_LIMITS,
  NAV_AREA_LIMITS,
  bakeNavArea,
  mergeHeightFields,
  navAgentPathVisuals,
  navAgentSettingsSig,
  navAreaSettingsSig,
  parseNavAgentSettings,
  parseNavAreaSettings,
  rasterizeMeshesToHeightField,
  sampleHeightField,
  sampleNavSdf,
  type NavHeightField,
  type NavObstacle,
} from "../../../src/framework/navigation";
import { findNavPath } from "../../../src/framework/navigation/pathfinding";
import { NavSystem } from "../../../src/framework/navigation/NavSystem";
import { createNavRuntime } from "../../../src/runtime/runtime/nav";
import { createDefaultRegistry } from "../../../src/framework/prototype/PrototypeRegistry";
import { NodeFactory } from "../../../src/framework/factory/NodeFactory";
import { NavAgentNode, NavAreaNode } from "../../../src/framework/prototype/derived/Primitives";
import { addNodeArgs, addNodeMenuItems, collectAddMenuTypes } from "../../../src/app/lib/node-menu";
import { geometryRegistry } from "../../../src/framework/mesh";
import { createSuite } from "../harness.mjs";

const { check, finish } = createSuite();

/** 平地高度场（y=0；bounds 0..20） */
function flatHeightAt(_x: number, _z: number): number | null {
  return 0;
}

const AREA_20: { minX: number; maxX: number; minZ: number; maxZ: number } = {
  minX: 0, maxX: 20, minZ: 0, maxZ: 20,
};

// ===========================================================================
console.log("[1] 数据层：默认值 / parse 收敛 / 签名");
{
  const d = DEFAULT_NAV_AREA_SETTINGS;
  check("默认设置齐全（7 字段）", Object.keys(d).length === 7);
  const p = parseNavAreaSettings(undefined);
  check("parse(undefined) 回退默认", JSON.stringify(p) === JSON.stringify(d));
  check("cellSize 钳进取值域", parseNavAreaSettings({ cellSize: 999 }).cellSize === NAV_AREA_LIMITS.cellSize.max);
  check("maxSlope 钳进取值域", parseNavAreaSettings({ maxSlope: 0 }).maxSlope === NAV_AREA_LIMITS.maxSlope.min);
  check("display 非法值回退 walkable", parseNavAreaSettings({ display: "x" }).display === "walkable");
  check("obstaclesMode 非法值回退 auto", parseNavAreaSettings({ obstaclesMode: "?" }).obstaclesMode === "auto");
  check("代理设置收敛", parseNavAgentSettings({ speed: -5 }).speed === NAV_AGENT_LIMITS.speed.min
    && parseNavAgentSettings({ radius: "x" }).radius === DEFAULT_NAV_AGENT_SETTINGS.radius);
  check("代理设置收敛（targetIds/mode/loop）", (() => {
    const p = parseNavAgentSettings({ targetIds: ["a", "a", 3, ""], moveMode: "x", loop: 1, speed: -5 });
    return p.targetIds.join() === "a" && p.moveMode === "sequence" && p.loop === true
      && p.speed === NAV_AGENT_LIMITS.speed.min;
  })());
  check("代理旧场景缺字段回退", (() => {
    const p = parseNavAgentSettings({ speed: 4 });
    return p.targetIds.length === 0 && p.moveMode === "sequence" && p.loop === true;
  })());
  check("设置签名逐字段变化", (() => {
    const a = navAreaSettingsSig(d);
    const b = navAreaSettingsSig({ ...d, cellSize: 2 });
    const c = navAreaSettingsSig({ ...d, sourceIds: ["t1"] });
    const e = navAreaSettingsSig({ ...d, sourceIds: ["t1", "t2"] });
    return a !== b && a !== c && c !== e;
  })());
  check("sourceIds 收敛（去重/滤非法/截断）", (() => {
    const p = parseNavAreaSettings({ sourceIds: ["a", "a", 5, "", "b"] });
    return p.sourceIds.length === 2 && p.sourceIds[0] === "a" && p.sourceIds[1] === "b";
  })());
  check("旧场景 terrainId 迁移为 sourceIds", parseNavAreaSettings({ terrainId: "t-old" }).sourceIds.join() === "t-old");
  check("代理签名逐字段变化", (() => {
    const base = { areaId: "", targetIds: [] as string[], moveMode: "sequence" as const, loop: false, speed: 4, radius: 0.5 };
    const a = navAgentSettingsSig(base);
    const b = navAgentSettingsSig({ ...base, speed: 5 });
    const c = navAgentSettingsSig({ ...base, targetIds: ["t1"] });
    const e = navAgentSettingsSig({ ...base, moveMode: "nearest" });
    const f = navAgentSettingsSig({ ...base, loop: true });
    return a !== b && a !== c && a !== e && a !== f;
  })());
}

// ===========================================================================
console.log("[2] 节点层：注册表 / 工厂 / 序列化往返");
{
  const registry = createDefaultRegistry();
  const factory = new NodeFactory(registry);
  check("注册表登记 navAreaNode/navAgentNode", registry.has("navAreaNode") && registry.has("navAgentNode"));
  const area = factory.createNavArea();
  check("工厂产出 NavAreaNode", area instanceof NavAreaNode && area.name === "Nav Area");
  const agent = factory.createNavAgent({ name: "Runner" });
  check("工厂产出 NavAgentNode + 命名", agent instanceof NavAgentNode && agent.name === "Runner");

  // toJSON → fromJSON 往返
  area.settings.cellSize = 2;
  area.settings.sourceIds = ["terrain-1", "mesh-1"];
  const doc = area.toJSON();
  const back = registry.createFromJSON(JSON.parse(JSON.stringify(doc)));
  check("区域节点 JSON 往返", back instanceof NavAreaNode
    && back.settings.cellSize === 2 && back.settings.sourceIds.join() === "terrain-1,mesh-1");
  agent.settings.speed = 7.5;
  agent.settings.targetIds = ["t1", "t2"];
  agent.settings.moveMode = "nearest";
  agent.settings.loop = true;
  const agentBack = registry.createFromJSON(JSON.parse(JSON.stringify(agent.toJSON())));
  check("代理节点 JSON 往返", agentBack instanceof NavAgentNode && agentBack.settings.speed === 7.5
    && agentBack.settings.targetIds.join() === "t1,t2" && agentBack.settings.moveMode === "nearest"
    && agentBack.settings.loop === true);
  // clone 深拷贝（targetIds 数组隔离）
  const agentClone = agent.clone();
  agentClone.settings.targetIds.push("y");
  check("clone 深拷贝（targetIds 隔离）", agent.settings.targetIds.join() === "t1,t2");

  // 旧场景兼容：无 settings 字段 → 默认；旧字段 terrainId → sourceIds 迁移
  const legacy = registry.createFromJSON({ type: "navAreaNode", id: "n1", name: "Old" });
  check("旧场景缺 settings 兼容", legacy instanceof NavAreaNode
    && legacy.settings.cellSize === DEFAULT_NAV_AREA_SETTINGS.cellSize);
  const legacyTerrain = registry.createFromJSON({
    type: "navAreaNode", id: "n1b", name: "Old2",
    settings: { cellSize: 1, agentRadius: 0.5, maxSlope: 45, maxHeightStep: 1.5, terrainId: "terrain-legacy", obstaclesMode: "auto", display: "off" },
  });
  check("旧场景 terrainId 设置迁移", legacyTerrain instanceof NavAreaNode
    && legacyTerrain.settings.sourceIds.join() === "terrain-legacy");
  const legacyAgent = registry.createFromJSON({ type: "navAgentNode", id: "n2", name: "Old" });
  check("代理旧场景兼容", legacyAgent instanceof NavAgentNode
    && legacyAgent.settings.speed === DEFAULT_NAV_AGENT_SETTINGS.speed);

  // clone 深拷贝（含 sourceIds 数组隔离）
  const cloned = area.clone();
  cloned.settings.sourceIds.push("changed");
  check("clone 深拷贝（sourceIds 数组隔离）", area.settings.sourceIds.join() === "terrain-1,mesh-1");
}

// ===========================================================================
console.log("[3] 烘焙：SDF 数值 / 坡度 / 高差 / 净空");
{
  // 方形障碍 [5,10]×[5,10]，1m 格：格心 5.5..9.5 → i=5..9, j=5..9
  const obstacles: NavObstacle[] = [
    { minX: 5, maxX: 10, minZ: 5, maxZ: 10, minY: 0, maxY: 3 },
  ];
  const bake = bakeNavArea({
    bounds: AREA_20,
    heightAt: flatHeightAt,
    obstacles,
    settings: { ...DEFAULT_NAV_AREA_SETTINGS, agentRadius: 0 },
  });
  check("网格尺寸 20×20", bake.w === 20 && bake.h === 20);
  check("障碍格数 25", bake.stats.cells === 400 && bake.stats.blockedCells === 25);

  // 确定性
  const bake2 = bakeNavArea({
    bounds: AREA_20, heightAt: flatHeightAt, obstacles,
    settings: { ...DEFAULT_NAV_AREA_SETTINGS, agentRadius: 0 },
  });
  check("同输入烘焙确定性", Array.from(bake.sdf).join() === Array.from(bake2.sdf).join());

  // SDF 数值：障碍正西邻格 (4,7) 格心 (4.5,7.5) → 到障碍 1.0；内部格 (7,7) 为负
  const sdfWest = sampleNavSdf(bake, 4.5, 7.5);
  check("障碍邻格 SDF ≈ 1.0", Math.abs(sdfWest - 1) < 1e-3, String(sdfWest));
  const sdfDiag = sampleNavSdf(bake, 4.5, 4.5);
  check("障碍对角邻格 SDF ≈ √2", Math.abs(sdfDiag - Math.SQRT2) < 1e-3, String(sdfDiag));
  const sdfInside = sampleNavSdf(bake, 7.5, 7.5);
  check("障碍内部 SDF 为负", sdfInside < 0, String(sdfInside));
  const sdfFar = sampleNavSdf(bake, 0.5, 0.5);
  check("SDF 距障碍越远越大", sdfFar > sdfWest);
  check("可行走统计（净空 0）", bake.stats.walkableCells === 400 - 25);

  // 代理半径净空：radius=1.5 → 障碍 1.5m 内的格不可行走（邻格 sdf=1 被排除）
  const bakeR = bakeNavArea({
    bounds: AREA_20, heightAt: flatHeightAt, obstacles,
    settings: { ...DEFAULT_NAV_AREA_SETTINGS, agentRadius: 1.5 },
  });
  check("半径净空排除近障碍格", sampleNavSdf(bakeR, 4.5, 7.5) >= 1.5
    ? bakeR.walkable[7 * bakeR.w + 4] === 1
    : bakeR.walkable[7 * bakeR.w + 4] === 0);
  check("远格仍可行走", bakeR.walkable[1 * bakeR.w + 1] === 1);

  // 坡度阻挡：坡度 2（>tan45°）全不可行走
  const bakeSteep = bakeNavArea({
    bounds: AREA_20, heightAt: (x) => x * 2, obstacles: [],
    settings: { ...DEFAULT_NAV_AREA_SETTINGS, maxSlope: 45 },
  });
  check("超坡度全阻挡", bakeSteep.stats.walkableCells === 0);
  // 缓坡（0.2 < tan45°）可行走
  const bakeGentle = bakeNavArea({
    bounds: AREA_20, heightAt: (x) => x * 0.2, obstacles: [],
    settings: { ...DEFAULT_NAV_AREA_SETTINGS, maxSlope: 45 },
  });
  check("缓坡可行走", bakeGentle.stats.walkableCells > 300);

  // 高差阻挡：x>10 处高差 5 的悬崖（maxHeightStep=1.5）
  const bakeCliff = bakeNavArea({
    bounds: AREA_20, heightAt: (x) => (x > 10 ? 5 : 0), obstacles: [],
    settings: { ...DEFAULT_NAV_AREA_SETTINGS },
  });
  check("悬崖近侧不可行走（高差超限）", (() => {
    // 格心 x=10.5 在悬崖上，其西侧格心 x=9.5 高差 5 > 1.5 → 被排除
    const i = 9, j = 10;
    return bakeCliff.walkable[j * bakeCliff.w + i] === 0;
  })());
  check("悬崖远侧平坦区可行走", (() => {
    const i = 15, j = 2;
    return bakeCliff.walkable[j * bakeCliff.w + i] === 1;
  })());

  // 高架障碍（底部高于地面 1m）不阻挡地面
  const bakeElevated = bakeNavArea({
    bounds: AREA_20, heightAt: flatHeightAt,
    obstacles: [{ minX: 5, maxX: 10, minZ: 5, maxZ: 10, minY: 2, maxY: 5 }],
    settings: { ...DEFAULT_NAV_AREA_SETTINGS, agentRadius: 0 },
  });
  check("高架障碍不阻挡地面", bakeElevated.stats.blockedCells === 0);
}

// ===========================================================================
console.log("[3b] 网格光栅化：meshField（任意 mesh 作为采样源）");
{
  // ① 平顶盒：顶面等高 = 2（取最高面），方形场内脚印外 NaN → null
  const box = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 4));
  box.position.set(10, 1, 10);
  const boxField = rasterizeMeshesToHeightField([box], { minX: 6, maxX: 14, minZ: 6, maxZ: 14 }, 0.5);
  check("光栅化产物非空", !!boxField);
  if (boxField) {
    const f: NavHeightField = { ...boxField, originY: 0 };
    check("盒顶面等高（indexed 几何）", sampleHeightField(f, 10, 10) === 2 && sampleHeightField(f, 8.2, 8.2) === 2);
    check("脚印外无表面（NaN → null）", sampleHeightField(f, 6.5, 10) === null && sampleHeightField(f, 13.8, 13.8) === null);

    // ② 用光栅化场烘焙：脚印边缘一圈（邻格 null → 高差判定）阻挡，内圈可行走
    const bakeBox = bakeNavArea({
      bounds: { minX: 8, maxX: 12, minZ: 8, maxZ: 12 },
      heightAt: (x, z) => sampleHeightField(f, x, z),
      obstacles: [],
      settings: { ...DEFAULT_NAV_AREA_SETTINGS, agentRadius: 0 },
    });
    check("网格源烘焙：外圈阻挡 + 内圈可行走（2×2）", bakeBox.stats.walkableCells === 4,
      `walkable=${bakeBox.stats.walkableCells}`);

    // ⑤ 地形 + 网格合并：脚印内取盒顶（2），脚印外回退地形（0）
    const terrainField: NavHeightField = {
      heights: new Float32Array(41 * 41), gridN: 41, size: 40,
      originX: 10, originZ: 10, originY: 0,
    };
    mergeHeightFields(boxField, [terrainField]);
    check("合并：脚印内取网格最高面", sampleHeightField(f, 10, 10) === 2);
    check("合并：脚印外回退地形面", sampleHeightField(f, 6.5, 10) === 0);
  }

  // ③ 斜坡（non-indexed 几何）：y = 0.5z（≈26.6° < 45°）→ 可行走
  const rampGeom = new THREE.BufferGeometry();
  rampGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
    0, 0, 0, 10, 0, 0, 10, 5, 10,
    0, 0, 0, 10, 5, 10, 0, 5, 10,
  ]), 3));
  const ramp = new THREE.Mesh(rampGeom);
  const rampField = rasterizeMeshesToHeightField([ramp], { minX: 0, maxX: 10, minZ: 0, maxZ: 10 }, 0.5);
  check("斜坡光栅化产物非空", !!rampField);
  if (rampField) {
    const rf: NavHeightField = { ...rampField, originY: 0 };
    const mid = sampleHeightField(rf, 5, 5);
    check("斜坡高度 = 0.5·z（non-indexed）", mid !== null && Math.abs(mid - 2.5) < 0.2, String(mid));
    const bakeRamp = bakeNavArea({
      bounds: { minX: 0, maxX: 10, minZ: 0, maxZ: 10 },
      heightAt: (x, z) => sampleHeightField(rf, x, z),
      obstacles: [],
      settings: { ...DEFAULT_NAV_AREA_SETTINGS, agentRadius: 0 },
    });
    check("缓坡网格源大面积可行走", bakeRamp.stats.walkableCells >= 60, `walkable=${bakeRamp.stats.walkableCells}`);
  }

  // ④ 两盒 XZ 重叠、顶面不同高 → 取最高
  const lower = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 4));
  lower.position.set(10, 1, 10);
  const upper = new THREE.Mesh(new THREE.BoxGeometry(4, 1, 4));
  upper.position.set(10, 3, 10);
  const overlapField = rasterizeMeshesToHeightField([lower, upper], { minX: 8, maxX: 12, minZ: 8, maxZ: 12 }, 0.5);
  check("重叠取最高面", overlapField !== null
    && sampleHeightField({ ...overlapField, originY: 0 }, 10, 10) === 3.5);

  // 退化输入：零尺寸范围 → null
  check("退化范围返回 null", rasterizeMeshesToHeightField([box], { minX: 5, maxX: 5, minZ: 5, maxZ: 5 }, 0.5) === null);
}

// ===========================================================================
console.log("[4] 寻路与代理：A* / 平滑 / 移动 / SDF 滑移");
{
  // 横墙 x∈[5,6], z∈[0,14]（z>14 留缺口）
  const wall: NavObstacle[] = [
    { minX: 5, maxX: 6, minZ: 0, maxZ: 14, minY: 0, maxY: 3 },
  ];
  const nav = bakeNavArea({
    bounds: AREA_20, heightAt: flatHeightAt, obstacles: wall,
    settings: { ...DEFAULT_NAV_AREA_SETTINGS, agentRadius: 0.5 },
  });

  // 直线可达（同侧）
  const short = findNavPath(nav, 1, 1, 3, 3, 0.5);
  check("短路径可达", short.found && short.points.length >= 2);
  check("平滑后路径点少（≤4）", short.points.length <= 4, String(short.points.length));

  // 绕墙：目标在墙另一侧、且 z 更小 → 必须绕到 z>14 缺口
  const detour = findNavPath(nav, 1, 1, 10, 1, 0.5);
  check("绕墙路径可达", detour.found);
  check("绕墙路径经过缺口（z>10）", detour.points.some((p) => p.z > 10),
    detour.points.map((p) => `${p.x.toFixed(1)},${p.z.toFixed(1)}`).join(" → "));
  check("终点吸附到请求坐标附近", detour.found
    && Math.hypot(detour.points[detour.points.length - 1].x - 10, detour.points[detour.points.length - 1].z - 1) < 1.5);

  // 目标在障碍内 → 吸附最近可行走格仍可达
  const into = findNavPath(nav, 1, 1, 7, 7, 0.5);
  check("目标在障碍内 → 吸附邻格可达", into.found);

  // 整墙阻断 → 不可达
  const full: NavObstacle[] = [
    { minX: 5, maxX: 6, minZ: 0, maxZ: 20, minY: 0, maxY: 3 },
  ];
  const blocked = bakeNavArea({
    bounds: AREA_20, heightAt: flatHeightAt, obstacles: full,
    settings: { ...DEFAULT_NAV_AREA_SETTINGS },
  });
  const unreachable = findNavPath(blocked, 1, 1, 10, 10, 0.5);
  check("整墙阻断不可达", !unreachable.found && unreachable.points.length === 0);

  // 低净空终点钳制：目标落在障碍投影内 → 终点停在最近可行走格中心而非原始坐标
  const clamped = findNavPath(nav, 1, 1, 5.5, 7, 0.5);
  check("低净空终点钳到可行走格中心", clamped.found && (() => {
    const last = clamped.points[clamped.points.length - 1];
    return sampleNavSdf(nav, last.x, last.z) >= 0.5 - 1e-6
      && Math.hypot(last.x - 5.5, last.z - 7) > 0.5;
  })());

  // —— NavSystem：绑定 / 烘焙 / 寻路推进 ——
  const registry = createDefaultRegistry();
  const factory = new NodeFactory(registry);
  const sys = new NavSystem();
  // 高度场比烘焙范围大一圈（±20 覆盖 0..20 全部采样点，含坡度/高差的外扩采样）
  sys.providers = {
    boundsFor: () => AREA_20,
    heightFieldFor: () => ({
      heights: new Float32Array(41 * 41), gridN: 41, size: 40,
      originX: 10, originZ: 10, originY: 0, sig: "flat",
    }),
    obstaclesFor: () => wall,
  };
  const areaNode = factory.createNavArea();
  const areaObj = new THREE.Group();
  sys.syncArea(areaNode, areaObj);
  check("区域注册即烘焙", sys.getAreaBake(areaNode.id) !== null);
  check("烘焙产物写入 userData", areaObj.userData.navBake === sys.getAreaBake(areaNode.id));
  check("障碍变化 → 签名失效重烘焙", (() => {
    const before = sys.getAreaBake(areaNode.id)!.stats.blockedCells;
    sys.providers = { ...sys.providers!, obstaclesFor: () => [] };
    sys.syncArea(areaNode, areaObj);
    const after = sys.getAreaBake(areaNode.id)!.stats.blockedCells;
    return before > 0 && after === 0;
  })());

  const agentNode = factory.createNavAgent();
  const agentObj = new THREE.Group();
  agentObj.position.set(1, 0, 1);
  sys.syncAgent(agentNode, agentObj);
  check("默认绑定第一个已烘焙区域", sys.requestPath(agentNode.id, 10, 10));
  check("路径已发布（可视化注册表）", (() => {
    const viz = (sys as unknown as { publishPath?: unknown }).publishPath;
    void viz;
    return sys.getAgentPath(agentNode.id) !== null && sys.getAgentPath(agentNode.id)!.length >= 2;
  })());

  // 推进数秒 → 逐步接近并最终到达（路径清空）
  let minXPos = 99;
  for (let i = 0; i < 60; i++) {
    sys.update(0.25);
    minXPos = Math.min(minXPos, Math.abs(agentObj.position.x - 10));
  }
  check("代理向目标推进", agentObj.position.x > 1 || minXPos < 9);
  check("到达后清路径", sys.getAgentPath(agentNode.id) === null);
  check("贴地高度 = 采样高度 + 抬升", Math.abs(agentObj.position.y) < 0.5);

  // —— 目标节点移动：sequence 依次接力 + loop 循环 ——
  sys.providers = {
    ...sys.providers!,
    targetFor: (id) => (id === "t1" ? { x: 16, z: 16 } : id === "t2" ? { x: 10, z: 1 } : null),
  };
  agentNode.settings.targetIds = ["t1", "t2"];
  agentNode.settings.moveMode = "sequence";
  agentNode.settings.loop = true;
  sys.syncAgent(agentNode, agentObj);
  check("巡回启动：走向第一个目标", sys.startAgent(agentNode.id) && sys.getAgentTargetIndex(agentNode.id) === 0);
  for (let i = 0; i < 200 && sys.getAgentTargetIndex(agentNode.id) === 0; i++) sys.update(0.25);
  check("到达第一个目标后接力第二个", sys.getAgentTargetIndex(agentNode.id) === 1);
  for (let i = 0; i < 400 && sys.getAgentTargetIndex(agentNode.id) === 1; i++) sys.update(0.25);
  check("loop 走完一轮回到第一个目标", sys.getAgentTargetIndex(agentNode.id) === 0);

  // —— nearest：跳过缺失目标，取路径最短的可达目标 ——
  agentNode.settings.moveMode = "nearest";
  agentNode.settings.loop = false;
  agentNode.settings.targetIds = ["t2", "t1", "t9"];
  sys.syncAgent(agentNode, agentObj);
  check("nearest 启动成功", sys.startAgent(agentNode.id));
  check("nearest 终点接近最近可达目标", (() => {
    const path = sys.getAgentPath(agentNode.id);
    const last = path?.[path.length - 1];
    return !!last && Math.hypot(last.x - 10, last.z - 1) < 1.5;
  })());
  check("nearest 游标置 -1", sys.getAgentTargetIndex(agentNode.id) === -1);

  // 目标节点移动（设置未变）→ syncAgent 按目标位置签名重评估：t2 移远后改选 t1
  sys.providers = {
    ...sys.providers!,
    targetFor: (id) => (id === "t1" ? { x: 16, z: 16 } : id === "t2" ? { x: 18, z: 18 } : null),
  };
  sys.syncAgent(agentNode, agentObj);
  check("目标移动后 nearest 重评估", (() => {
    const path = sys.getAgentPath(agentNode.id);
    const last = path?.[path.length - 1];
    return !!last && Math.hypot(last.x - 16, last.z - 16) < 1.5;
  })());

  // 手动烘焙 + 统计
  const stats = sys.getAreaStats(areaNode.id);
  check("统计可读", !!stats && stats.cells > 0 && stats.bakeMs >= 0);
  sys.unbind(agentNode.id);
  sys.unbind(areaNode.id);
  check("解绑后路径清除", sys.getAgentPath(agentNode.id) === null && sys.getAreaBake(areaNode.id) === null);
  sys.syncArea(areaNode, areaObj);
  sys.syncAgent(agentNode, agentObj);
  sys.unbindAll();
  check("unbindAll 清空全部绑定（场景整体重建用）", sys.firstAreaId() === ""
    && sys.getAreaBake(areaNode.id) === null && sys.getAgentPath(agentNode.id) === null);
}

// ===========================================================================
console.log("[5] 契约：菜单 / 命令 / 同步器 / 引擎 / 检查器");
{
  const menu = addNodeMenuItems({
    geometry: geometryRegistry.list().map((g) => ({ key: g.key, label: g.label })),
    scripts: [],
  });
  const types = collectAddMenuTypes(menu);
  check("菜单含导航分组（nav:area / nav:agent）", types.includes("nav:area") && types.includes("nav:agent"));
  const args = addNodeArgs("nav:area", "p1");
  check("nav:area → kind=nav + subtype=area", args?.kind === "nav" && args?.subtype === "area");
  check("nav:agent → subtype=agent", addNodeArgs("nav:agent", "p1")?.subtype === "agent");
  check("nav → 注册表闭环", (() => {
    const registry = createDefaultRegistry();
    return registry.has("navAreaNode") && registry.has("navAgentNode");
  })());

  const nodeCmds = readFileSync(resolve(process.cwd(), "src/app/commands/nodeCommands.ts"), "utf8");
  check("nodeCommands 有 nav 分支", /case "nav":/.test(nodeCmds) && /addNavArea/.test(nodeCmds) && /addNavAgent/.test(nodeCmds));

  const syncSrc = readFileSync(resolve(process.cwd(), "src/framework/engine/modules/SceneSynchronizer.ts"), "utf8");
  check("同步器：导航叠层刷新 + 子对象名 + 层跟随", /refreshNavArea/.test(syncSrc)
    && /__navMesh/.test(syncSrc) && /NAV_MESH_NAME/.test(syncSrc));

  const engineSrc = readFileSync(resolve(process.cwd(), "src/framework/engine/EditorEngine.ts"), "utf8");
  check("引擎：SCRIPT_NODE_BASE 登记（漏登记编译报错机制）", /navAreaNode: \(e, p\) => e.addNavArea\(p\)/.test(engineSrc)
    && /navAgentNode: \(e, p\) => e.addNavAgent\(p\)/.test(engineSrc));
  check("引擎：渲染循环推进 nav", /this\.nav\.update\(dt\)/.test(engineSrc));
  check("引擎：图事件接线（烘焙/解绑）", /this\.nav\.unbind/.test(engineSrc) && /this\.nav\.syncArea/.test(engineSrc));
  check("引擎：烘焙输入提供者（多源解析 + 网格光栅化 + 障碍收集）", /navSourcesOf/.test(engineSrc)
    && /rasterizeMeshesToHeightField/.test(engineSrc) && /navObstaclesFor/.test(engineSrc));
  check("引擎：场景变化重检 + 模型加载失效缓存", /resyncNavAreas/.test(engineSrc)
    && /navFieldCache\.clear\(\)/.test(engineSrc));

  const meshFieldSrc = readFileSync(resolve(process.cwd(), "src/framework/navigation/meshField.ts"), "utf8");
  check("光栅化器：顶面优先 + NaN 无表面语义", /mergeHeightFields/.test(meshFieldSrc) && /NaN/.test(meshFieldSrc));

  const helperSrc = readFileSync(resolve(process.cwd(), "src/framework/engine/modules/helpers/createNodeHelper.ts"), "utf8");
  check("代理助手线已注册", /NavAgentHelper/.test(helperSrc));

  const navSysSrc = readFileSync(resolve(process.cwd(), "src/framework/navigation/NavSystem.ts"), "utf8");
  check("代理：目标寻路（startAgent/巡回接力/最近可达/目标位置签名）", /startAgent/.test(navSysSrc)
    && /advanceSequence/.test(navSysSrc) && /repathNearest/.test(navSysSrc) && /targetFor\?/.test(navSysSrc));
  check("引擎：代理目标位置提供者", /navTargetOf/.test(engineSrc)
    && /targetFor: \(nodeId\) => this\.navTargetOf\(nodeId\)/.test(engineSrc));
  check("引擎：整体重建重绑导航（打开项目后勾选/绑定不丢）", (() => {
    const rb = engineSrc.match(/rebuildAll\(\): void \{[\s\S]*?\n  \}/);
    return !!rb && /nav\.unbindAll\(\)/.test(rb[0])
      && /navFieldCache\.clear\(\)/.test(rb[0])
      && /nav\.syncArea\(node, obj\)/.test(rb[0])
      && /nav\.syncAgent\(node, obj\)/.test(rb[0]);
  })());

  const agentSectionSrc = readFileSync(resolve(process.cwd(), "src/app/components/inspector/NavAgentSection.vue"), "utf8");
  check("检查器：代理目标多选 + 移动模式", /NodeMultiSelect/.test(agentSectionSrc)
    && /moveMode/.test(agentSectionSrc) && /startAgent/.test(agentSectionSrc));
  check("检查器：共享节点多选组件（ui-kit 通用 MultiSelect + 业务适配）", (() => {
    const ms = readFileSync(resolve(process.cwd(), "src/ui-kit/components/MultiSelect.vue"), "utf8");
    const wrap = readFileSync(resolve(process.cwd(), "src/app/components/inspector/NodeMultiSelect.vue"), "utf8");
    return /Teleport/.test(ms) && /selectedIds/.test(ms) && /MultiSelect/.test(wrap);
  })());

  const panel = readFileSync(resolve(process.cwd(), "src/app/components/InspectorPanel.vue"), "utf8");
  check("检查器：Nav Area / Nav Agent 卡", /NavAreaSection/.test(panel) && /NavAgentSection/.test(panel));

  const sectionSrc = readFileSync(resolve(process.cwd(), "src/app/components/inspector/NavAreaSection.vue"), "utf8");
  check("检查器：Sources 多选（地形 + 网格）", /sourceIds/.test(sectionSrc) && /MeshNode/.test(sectionSrc)
    && /Set Nav Sources/.test(sectionSrc));

  const hierarchySrc = readFileSync(resolve(process.cwd(), "src/app/components/HierarchyPanel.vue"), "utf8");
  check("层级：导航节点图标登记", /navAreaNode: \{ d: NAV_AREA_ICON_PATHS/.test(hierarchySrc)
    && /navAgentNode: \{ d: NAV_AGENT_ICON_PATHS/.test(hierarchySrc));

  const runner = resolve(process.cwd(), "scripts", "smoke", "runner.mjs");
  check("统一入口 runner.mjs 已就位（本脚本由其动态发现）", existsSync(runner));
}

// ===========================================================================
console.log("[6] 运行时导航（预览 player 装配语义）：采样源不进障碍表");
{
  // 复刻预览 createNavRuntime 的回退语义：sourceIds 为空 → 自动采第一块地形；
  // 地形自带 heightfield 碰撞体（项目常见配置）→ obstaclesMode auto 下，
  // 采样源自身若被当作障碍会把全图判 blocked → 烘焙 0 可行走 → 代理不动
  const terrainObj = new THREE.Group();
  terrainObj.name = "__terrainMesh";
  // 地形节点常被整体下移（起伏场地）：贴地高度必须按节点世界 Y 换算（与编辑器一致）
  terrainObj.position.set(0, -14, 0);
  const terrainMesh = new THREE.Mesh(new THREE.BoxGeometry(200, 4, 200));
  terrainMesh.userData.terrainHeights = new Float32Array(33 * 33); // 平地高度场
  terrainMesh.userData.terrainGridSize = 33;
  terrainMesh.userData.terrainSize = 200;
  terrainObj.add(terrainMesh);
  const targetObj = new THREE.Group();
  targetObj.position.set(10, 0, 0);
  const scene6 = new THREE.Scene();
  scene6.add(terrainObj, targetObj);
  const nodes6 = [
    { json: { id: "t1", type: "terrainNode", active: true, visible: true, components: [{ type: "collider", enabled: true }] }, obj: terrainObj },
    { json: { id: "a1", type: "navAreaNode", active: true, visible: true, settings: { cellSize: 2, agentRadius: 0.5, maxSlope: 45, maxHeightStep: 1.2, sourceIds: [], obstaclesMode: "auto", display: "off" } }, obj: new THREE.Group() },
    { json: { id: "ag1", type: "navAgentNode", active: true, visible: true, settings: { areaId: "a1", targetIds: ["p1"], moveMode: "sequence", loop: true, speed: 4, radius: 0.5 } }, obj: new THREE.Group() },
    { json: { id: "p1", type: "meshNode", active: true, visible: true }, obj: targetObj },
  ] as unknown as Parameters<typeof createNavRuntime>[0]["nodes"];
  const nav6 = createNavRuntime({ scene: scene6, nodes: nodes6, onLog: () => {} });
  const bake6 = (nodes6[1].obj as unknown as { userData: { navBake: { stats: { walkableCells: number; cells: number } } } }).userData.navBake;
  check("运行时烘焙产物已生成", !!bake6);
  check("采样源（带碰撞体的地形）不阻塞烘焙——可行走 > 0", !!bake6 && bake6.stats.walkableCells > 0,
    `walkable=${bake6?.stats.walkableCells}/${bake6?.stats.cells}`);
  check("烘焙后图内寻路可达", !!bake6 && nav6.pathBetween({ x: -10, z: 0 }, { x: 10, z: 0 }) !== null);
  check("代理自动巡回启动成功", (() => {
    // startAgent 结果不可直接观察（autoStart 在装配时执行）；用代理状态等价通道：
    // 路径已发布 → 编辑器可视化注册表非空（与编辑器 NavSystem 同一注册表）
    return navAgentPathVisuals.has("ag1");
  })());
  check("贴地高度按地形节点世界 Y 换算（高度场平地 0、节点 y=-14 → 烘焙高度 ≈ -14）", (() => {
    const c = Math.floor(bake6!.stats.cells / 2);
    return Math.abs(bake6!.heights[c] - (-14)) < 0.25;
  })());
  nav6.update(0.25);
  check("代理推进后贴地（y ≈ -14 + 抬升）", nodes6[2].obj.position.y < -13, `y=${nodes6[2].obj.position.y.toFixed(2)}`);
  nav6.dispose();
}

// ===========================================================================
finish();
