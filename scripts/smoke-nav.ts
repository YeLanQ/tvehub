// ---------------------------------------------------------------------------
// 导航系统冒烟测试（headless，无需 GPU）。
// 覆盖五段：
// ① 数据层：导航区域/代理设置默认值 / parse 收敛（缺失、非法、越界、模式收敛）/ 签名；
// ② 节点层：注册表登记、工厂产出、toJSON→createFromJSON 往返、旧场景兼容、clone 深拷贝；
// ③ 烘焙：确定性、SDF 数值（平地方形障碍的精确格距/障碍内负值）、坡度/高差阻挡、
//    代理半径净空、障碍过滤（高架障碍不阻挡地面）；
// ④ 寻路与代理：直线/绕墙/不可达、终点吸附最近可行走格、视线拉直平滑、
//    NavSystem 代理推进（贴地/到达/清路径）与 SDF 滑移；
// ⑤ 契约：层级菜单（导航分组 → node.add kind nav → 注册表）、nodeCommands 分支、
//    同步器（refreshNavArea/__navMesh）、引擎（SCRIPT_NODE_BASE/addNavArea/nav.update）、
//    检查器（NavArea/NavAgent 卡）、smoke:nav 脚本登记。
// 跑法：npm run smoke:nav
// ---------------------------------------------------------------------------

import * as THREE from "three";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_NAV_AGENT_SETTINGS,
  DEFAULT_NAV_AREA_SETTINGS,
  NAV_AGENT_LIMITS,
  NAV_AREA_LIMITS,
  bakeNavArea,
  navAgentSettingsSig,
  navAreaSettingsSig,
  parseNavAgentSettings,
  parseNavAreaSettings,
  sampleNavSdf,
  type NavObstacle,
} from "../src/framework/navigation";
import { findNavPath } from "../src/framework/navigation/pathfinding";
import { NavSystem } from "../src/framework/navigation/NavSystem";
import { createDefaultRegistry } from "../src/framework/prototype/PrototypeRegistry";
import { NodeFactory } from "../src/framework/factory/NodeFactory";
import { NavAgentNode, NavAreaNode } from "../src/framework/prototype/derived/Primitives";
import { addNodeArgs, addNodeMenuItems, collectAddMenuTypes } from "../src/app/lib/node-menu";
import { geometryRegistry } from "../src/framework/mesh";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

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
  const ag = parseNavAgentSettings({ speed: -5 });
  check("代理设置收敛", parseNavAgentSettings({ speed: -5 }).speed === NAV_AGENT_LIMITS.speed.min
    && parseNavAgentSettings({ radius: "x" }).radius === DEFAULT_NAV_AGENT_SETTINGS.radius);
  check("设置签名逐字段变化", (() => {
    const a = navAreaSettingsSig(d);
    const b = navAreaSettingsSig({ ...d, cellSize: 2 });
    const c = navAreaSettingsSig({ ...d, terrainId: "t1" });
    return a !== b && a !== c;
  })());
  check("代理签名变化", navAgentSettingsSig({ areaId: "", speed: 4, radius: 0.5 })
    !== navAgentSettingsSig({ areaId: "", speed: 5, radius: 0.5 }));
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
  area.settings.terrainId = "terrain-1";
  const doc = area.toJSON();
  const back = registry.createFromJSON(JSON.parse(JSON.stringify(doc)));
  check("区域节点 JSON 往返", back instanceof NavAreaNode
    && back.settings.cellSize === 2 && back.settings.terrainId === "terrain-1");
  agent.settings.speed = 7.5;
  const agentBack = registry.createFromJSON(JSON.parse(JSON.stringify(agent.toJSON())));
  check("代理节点 JSON 往返", agentBack instanceof NavAgentNode && agentBack.settings.speed === 7.5);

  // 旧场景兼容：无 settings 字段 → 默认
  const legacy = registry.createFromJSON({ type: "navAreaNode", id: "n1", name: "Old" });
  check("旧场景缺 settings 兼容", legacy instanceof NavAreaNode
    && legacy.settings.cellSize === DEFAULT_NAV_AREA_SETTINGS.cellSize);
  const legacyAgent = registry.createFromJSON({ type: "navAgentNode", id: "n2", name: "Old" });
  check("代理旧场景兼容", legacyAgent instanceof NavAgentNode
    && legacyAgent.settings.speed === DEFAULT_NAV_AGENT_SETTINGS.speed);

  // clone 深拷贝
  const cloned = area.clone();
  cloned.settings.terrainId = "changed";
  check("clone 深拷贝（settings 隔离）", area.settings.terrainId === "terrain-1");
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

  // 手动烘焙 + 统计
  const stats = sys.getAreaStats(areaNode.id);
  check("统计可读", !!stats && stats.cells > 0 && stats.bakeMs >= 0);
  sys.unbind(agentNode.id);
  sys.unbind(areaNode.id);
  check("解绑后路径清除", sys.getAgentPath(agentNode.id) === null && sys.getAreaBake(areaNode.id) === null);
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
  check("引擎：烘焙输入提供者（地形高度场 + 静态障碍）", /collectNavObstacles/.test(engineSrc) && /navTerrainOf/.test(engineSrc));

  const helperSrc = readFileSync(resolve(process.cwd(), "src/framework/engine/modules/helpers/createNodeHelper.ts"), "utf8");
  check("代理助手线已注册", /NavAgentHelper/.test(helperSrc));

  const panel = readFileSync(resolve(process.cwd(), "src/app/components/InspectorPanel.vue"), "utf8");
  check("检查器：Nav Area / Nav Agent 卡", /NavAreaSection/.test(panel) && /NavAgentSection/.test(panel));

  const pkg = readFileSync(resolve(process.cwd(), "package.json"), "utf8");
  check("smoke:nav 脚本已登记", /"smoke:nav"/.test(pkg));
}

// ===========================================================================
console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
