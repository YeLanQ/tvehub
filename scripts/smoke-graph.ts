// ---------------------------------------------------------------------------
// 脚本图（framework/graph + graph-window）冒烟测试（headless，无需 GPU）。
// 脚本图是"另外的编辑模式"：层级实体拖入生成原型卡片，匹配节点按标签/类型
// 批量圈定，原子操作节点定义预览运行时执行的行为（不回写场景、无图资产）。
// 覆盖五段：
// ① 会话模型：normalizeGraphDoc 收敛（kind/未知操作剔除/参数钳制/连线通道/
//    自环/入端口唯一/注释框钳制）、id 生成、端口通道表；
// ② 操作目录：六种原子操作、触发时机固定、缺省参数、摘要；
// ③ 运行时契约：graph-behaviors 解释器（userData 匹配/交互/每帧）、
//    player.mjs 注入钩子（config.scriptGraph → 装配 → update → dispose）；
// ④ 窗口契约：tauri.conf 窗口、capabilities 授权、Hub 入口（graph-launch /
//    ProjectsSection）、graph.html/graph-main（布防/握手/不自行 show）、蒙版；
// ⑤ 工作台：store（侧车自动保存/场景索引/无图资产）、画布（三卡片/拖入/
//    校验）、检查器、预览注入；并断言旧资产化路线（scriptgraph_write/.graph
//    资产/保存按钮）确已移除。
// 跑法：npm run smoke:graph
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  GRAPH_OP_DEFS,
  canConnectPorts,
  emptyGraphDoc,
  graphOpDefaults,
  graphOpDef,
  graphNodeLabel,
  graphNodePorts,
  graphPort,
  isGraphDoc,
  normalizeGraphDoc,
  type GNode,
  type GPortInfo,
} from "../src/framework/graph";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const port = (id: string, channel: GPortInfo["channel"], direction: GPortInfo["direction"]): GPortInfo => ({
  id,
  channel,
  direction,
});

// ===========================================================================
console.log("① 会话模型");
{
  const doc = normalizeGraphDoc({
    nodes: [
      { id: "a", kind: "proto", x: 0, y: 0, entityId: "ent_1" },
      { id: "b", kind: "nope", x: 0, y: 0 },
      { id: "c", kind: "match", x: 9e9, y: 0, matchMode: "other", matchPattern: "enemy" },
      { id: "d", kind: "op", x: 0, y: 0, opType: "op.spin", params: { speedX: 10, speedY: "x", speedZ: 999 } },
      { id: "e", kind: "op", x: 0, y: 0, opType: "op.nope", params: {} },
    ],
    edges: [
      { id: "e1", srcNode: "a", srcPort: "out", dstNode: "d", dstPort: "in" },
      { id: "e2", srcNode: "a", srcPort: "out", dstNode: "c", dstPort: "in" },
      { id: "e3", srcNode: "d", srcPort: "out", dstNode: "d", dstPort: "in" },
      { id: "e4", srcNode: "a", srcPort: "out", dstNode: "d", dstPort: "exec" },
    ],
    comments: [{ id: "c1", x: 0, y: 0, w: 1, h: 99999, text: "note", color: "zzz" }],
  });
  check(doc.nodes.length === 3, `未知 kind / 未知操作剔除（实际 ${doc.nodes.length}）`);
  check(doc.nodes[1].matchMode === "tag", "非法匹配模式回退 tag");
  check(doc.nodes[1].x === 20000, "坐标钳制");
  const spin = doc.nodes.find((n) => n.opType === "op.spin");
  check(
    !!spin && spin.params?.speedX === 10 && spin.params?.speedY === 45 && spin.params?.speedZ === 999,
    "操作参数按字段收敛（非数值回退缺省）",
  );
  check(doc.edges.length === 1, `通道不符/自环剔除后剩 1 条（实际 ${doc.edges.length}）`);
  check(doc.edges[0].dstPort === "in", "保留实体集通道连线");
  check(doc.comments[0].w === 80 && doc.comments[0].h === 2000, "注释框尺寸钳制");
  check(doc.comments[0].color === "#dcdcaa", "非法颜色回退缺省");

  check(isGraphDoc({ nodes: [], edges: [] }), "isGraphDoc 接受空图");
  check(!isGraphDoc({}), "isGraphDoc 拒绝非图");

  // 端口通道表：原型/匹配只有实体集源；操作有实体入/执行入/实体出/执行出
  const proto: GNode = { id: "p", kind: "proto", x: 0, y: 0, entityId: "e" };
  const op: GNode = { id: "o", kind: "op", x: 0, y: 0, opType: "op.spin", params: {} };
  check(graphNodePorts(proto).length === 1 && graphNodePorts(proto)[0].channel === "entities", "原型仅实体集源端口");
  check(graphNodePorts(op).length === 4, "操作节点四端口");
  check(graphPort(op, "in", "in")?.channel === "entities", "op.in = 实体集入");
  check(graphPort(op, "exec", "in")?.channel === "exec", "op.exec = 执行链入");
  check(!canConnectPorts(port("out", "entities", "out"), port("exec", "exec", "in")), "实体集 → 执行链拒绝");
  check(canConnectPorts(port("out", "entities", "out"), port("in", "entities", "in")), "实体集 → 实体集");

  // 标签推导显示名
  const m: GNode = { id: "m", kind: "match", x: 0, y: 0, matchMode: "tag", matchPattern: "enemy" };
  check(graphNodeLabel(m).includes("enemy"), "匹配节点显示名含模式串");
  check(graphNodeLabel({ id: "x", kind: "proto", x: 0, y: 0 }, { entityName: () => "Box01" }) === "Box01", "原型显示名取实体名");

  const g1 = normalizeGraphDoc(emptyGraphDoc());
  check(g1.nodes.length === 0, "空图合法");
}

// ===========================================================================
console.log("② 操作目录");
{
  const types = GRAPH_OP_DEFS.map((d) => d.type);
  check(new Set(types).size === types.length, "操作类型唯一");
  check(types.includes("op.set") && types.includes("op.spin") && types.includes("op.bob") && types.includes("op.fireFsm") && types.includes("op.setFsmParam") && types.includes("op.toggleVisible"), "六种原子操作齐备");
  // 触发时机由类型固定
  check(graphOpDef("op.spin")?.trigger === "frame", "spin = 每帧");
  check(graphOpDef("op.set")?.trigger === "start", "set = 启动时");
  check(graphOpDef("op.toggleVisible")?.trigger === "click", "toggleVisible = 点击时");
  check(graphOpDef("op.fireFsm")?.trigger === "click", "fireFsm = 点击时");
  // 缺省参数
  const defaults = graphOpDefaults("op.spin");
  check(defaults.speedY === 45, "spin.speedY 缺省 45");
  check(Object.keys(graphOpDefaults("op.nope")).length === 0, "未知操作缺省参数为空");
}

// ===========================================================================
console.log("③ 运行时契约");
{
  const read = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf-8");

  const beh = read("src/runtime/runtime/graph-behaviors.ts");
  check(beh.includes("createGraphBehaviors"), "解释器导出 createGraphBehaviors");
  check(beh.includes("nodeTag") && beh.includes("nodeKind") && beh.includes("nodeId"), "按 userData 标签/类型/id 匹配");
  check(beh.includes("pointerdown") && beh.includes("Raycaster"), "点击行为走指针射线");
  check(beh.includes("logicApi") && beh.includes(".fire("), "FSM 事件经 engine.logic 语义");
  check(beh.includes("update(dt"), "每帧行为推进");

  const player = read("public/web-preview/player.mjs");
  check(player.includes("engine/runtime/graph-behaviors.mjs"), "player 导入解释器");
  check(player.includes("cfg.scriptGraph") && player.includes("script-graph.json"), "player 按 config.scriptGraph 装配注入文档");
  check(player.includes("graphBehaviors.update(dt)"), "player 每帧推进行为");
  check(player.includes("graphBehaviors.dispose()"), "player 卸载时清理行为");
}

// ===========================================================================
console.log("④ 窗口契约");
{
  const read = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf-8");

  const conf = JSON.parse(read("src-tauri/tauri.conf.json")) as {
    app: { windows: { label: string; url: string; visible: boolean }[] };
  };
  const gw = conf.app.windows.find((w) => w.label === "graph");
  check(!!gw && gw.url === "graph.html" && gw.visible === false, "tauri.conf.json graph 窗口（隐藏常驻）");

  const cap = JSON.parse(read("src-tauri/capabilities/default.json")) as {
    windows: string[];
    permissions: string[];
  };
  check(cap.windows.includes("graph"), "capabilities：graph 窗口已授权");
  check(cap.permissions.includes("core:window:allow-hide"), "capabilities：graph 关闭按钮需要 allow-hide");

  const lib = read("src-tauri/src/lib.rs");
  check(lib.includes("async fn show_window_with_project") && lib.includes("show_window_with_project,"), "lib.rs show_window_with_project 统一命令与注册");
  check(lib.includes("WINDOW_LIFECYCLE") && lib.includes("CloseAction::Hide"), "lib.rs 声明式窗口生命周期表");

  // 场景会话按场景 rel 分键：同一场景全窗口共享一份数据（含未保存修改），
  // 不同场景各自会话互不冲突；会话按 (root,rel) 复合键分，事件载荷带 root+rel
  const sceneMod = read("src-tauri/src/scene/mod.rs");
  check(
    sceneMod.includes("sessions: std::collections::HashMap<SessionKey, SessionCore>") && sceneMod.includes("current: std::collections::HashMap<String, SessionKey>"),
    "后端：会话按 (root,rel) 复合键分键 + 各窗口当前指针",
  );
  check(sceneMod.includes("pub root: Option<String>,") && sceneMod.includes("pub rel: String,") && sceneMod.includes('app.emit("scene:changed"'), "后端：scene:changed 载荷带 root+rel 全局广播");
  check(
    sceneMod.includes("webview: tauri::Webview,") && !sceneMod.includes("tauri::WebviewWindow"),
    "后端：命令参数用可注入的 tauri::Webview（WebviewWindow 无法注入会导致运行时全失败）",
  );

  const launch = read("src/app/lib/graph-launch.ts");
  check(
    launch.includes("handoffToWindow") && launch.includes('"graph"'),
    "Hub 侧打开助手（统一窗口交接 handoffToWindow）",
  );
  const projects = read("src/app/components/home/ProjectsSection.vue");
  check(projects.includes("openScriptGraphWindow") && projects.includes("打开脚本图"), "项目卡片菜单「打开脚本图」");

  check(read("graph.html").includes("src/graph-main.ts"), "graph.html 入口");
  const gmain = read("src/graph-main.ts");
  check(
    gmain.includes("window:project-open") && gmain.includes("takePendingProject") && gmain.includes("getGraphBootStore().standby()"),
    "graph-main 统一交接事件 + 冷启动拉取 + 蒙版布防",
  );
  check(!gmain.includes("getCurrentWindow().show"), "graph-main 不自行显示窗口（由 show_window_with_project 控制）");
  const mask = read("src/graph-window/components/GraphBootMask.vue");
  check(mask.includes("boot-mask") && mask.includes("TVE <span>GRAPH</span>"), "装载蒙版复用编辑器 boot-mask 视觉");

  // 编辑器界面不被改动（入口只在 Hub）
  const toolbar = read("src/app/components/Toolbar.vue");
  check(!toolbar.includes("脚本图"), "编辑器工具栏未加脚本图入口");
}

// ===========================================================================
console.log("⑤ 工作台与无图资产契约");
{
  const read = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf-8");

  const store = read("src/graph-window/graphStore.ts");
  check(
    store.includes("sidecarRel") && store.includes(".tve/script-graph/") && store.includes("writeText"),
    "store：图会话侧车自动保存（.tve 旁路，无图资产）",
  );
  check(
    store.includes("fetchSceneEntities") && store.includes("markGraphDirty") && store.includes("flushGraph"),
    "store：场景实体索引/脏标记/卸载冲刷",
  );
  check(
    store.includes("async openScene(rel)") && store.includes("sceneApi.open"),
    "store：双击场景资产 → openScene 切当前场景",
  );
  // 两窗口仅资产数据共享：无跨窗口场景事件
  const project = read("src/app/stores/project.ts");
  check(!project.includes("editor:scene-open"), "编辑器不广播场景指针（窗口独立）");
  check(!store.includes("editor:scene-open"), "图窗口不跟随编辑器场景指针");

  const canvas = read("src/graph-window/components/GraphCanvas.vue");
  check(
    canvas.includes("#node-gproto") && canvas.includes("#node-gmatch") && canvas.includes("#node-gop") && canvas.includes("#node-gcomment"),
    "画布：原型/匹配/操作/注释框四类插槽",
  );
  check(
    canvas.includes("application/x-tve-entity") && canvas.includes("addProto"),
    "画布：层级拖入生成原型",
  );
  check(canvas.includes("is-valid-connection") && canvas.includes("requestSnapshot"), "画布：连线校验/会话快照");

  const inspector = read("src/graph-window/components/NodeInspector.vue");
  check(
    inspector.includes("sceneEntities") && inspector.includes("commitParam") && inspector.includes("G_OP_TRIGGER_LABEL"),
    "检查器：实体属性参照/操作参数表/触发徽标",
  );

  const preview = read("src/graph-window/components/GraphPreview.vue");
  check(
    preview.includes("script-graph.json") && preview.includes("scriptGraph") && preview.includes("exportWebPreviewFromScene"),
    "预览：注入脚本图文档 + config 标记（与编辑器同一导出链路）",
  );
  const assetsPanel = read("src/graph-window/components/GraphAssets.vue");
  check(
    assetsPanel.includes('item.kind === "scene"') && assetsPanel.includes("openScene") && !assetsPanel.includes("clipboard"),
    "资产面板：双击场景打开（无复制路径）",
  );

  const hierarchy = read("src/graph-window/components/GraphHierarchy.vue");
  check(hierarchy.includes("dragstart") && hierarchy.includes("addProto"), "层级：行拖入生成原型");
  // 面板与编辑器一致性：同款样式类/真件复用/同源数据
  check(
    hierarchy.includes("hierarchy-panel.scss") && hierarchy.includes("panel hierarchy") && hierarchy.includes("NODE_ICONS"),
    "层级：编辑器同款结构/样式/图标",
  );
  const assets = read("src/graph-window/components/GraphAssets.vue");
  check(
    assets.includes("getAssetsStore") && assets.includes("AssetToolbar") && assets.includes("AssetEntryCell") && assets.includes("assets-panel.scss"),
    "资产：编辑器同源数据 + 真件复用（工具栏/条目）",
  );

  // 停靠系统：图窗口复刻编辑器 docks（页签拖拽/浮动/分隔条调宽），布局键隔离
  const docks = read("src/graph-window/docks.ts");
  check(
    docks.includes("tve:graph:dock-layout:v1") && docks.includes("initGraphDocks") && docks.includes("uiStateSet"),
    "dock：图窗口布局注册表（层级/检查器/资产）+ 后端 UI 状态 KV 持久化",
  );
  const dnd = read("src/graph-window/graph-dock-dnd.ts");
  check(dnd.includes("beginTabDrag") && dnd.includes("dock-dragging"), "dock：页签拖拽（移动/停靠/浮动）");
  const zone = read("src/graph-window/components/GraphDockZone.vue");
  check(
    zone.includes('class="dock-zone"') && zone.includes("data-dock-tab") && zone.includes("dock-body"),
    "dock：停靠区同款页签/落点/空区细条",
  );
  const appSrc = read("src/graph-window/GraphApp.vue");
  check(
    appSrc.includes("GraphDockZone") && appSrc.includes("beginZoneResize") && appSrc.includes("splitter") && appSrc.includes("GraphFloatingDock") && appSrc.includes("dock-ghost"),
    "工作区：停靠区 + 分隔条调宽 + 浮动面板 + 拖拽幽灵",
  );

  // 旧资产化路线确已移除
  const logic = read("src-tauri/src/scene/logic_assets.rs");
  check(!logic.includes("scriptgraph"), "Rust 无 scriptgraph 资产命令");
  const api = read("src/lib/api.ts");
  check(!api.includes("scriptGraphWrite") && !api.includes("scriptgraph_write"), "api.ts 无图资产门面");
  const app = read("src/graph-window/GraphApp.vue");
  check(!app.includes("store.save()"), "工作台无保存按钮（自动保存）");
  const graphAppSrc = read("src/graph-window/graphStore.ts");
  check(!graphAppSrc.includes("scriptGraphWrite"), "store 无图资产写入");
}

// ===========================================================================
console.log(passed === 0 && failed === 0 ? "无断言" : `\n${passed} 项通过，${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
