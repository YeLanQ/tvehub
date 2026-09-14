// ---------------------------------------------------------------------------
// 有限状态机（.fsm）+ 行为树（.bt）冒烟测试（headless，无需 GPU）。
// 覆盖五段：
// ① FSM 数据层：parse 收敛（缺字段/非法引用/自环/重名/参数收敛）/ 助手函数；
// ② FSM 求值：定时触发、事件触发、参数条件触发、链式即时过渡、forceState、生命周期回调；
// ③ BT 数据层：注册表、parse 收敛（未知类型剔除/叶子裁剪/字段钳制）、默认树、助手函数；
// ④ BT 求值：sequence/selector running 记忆恢复、parallel、invert/succeeder、
//    repeat/retry、timeout、wait/condition/action；
// ⑤ 契约：Rust 命令（logic_assets.rs / lib.rs）、api 门面、资产菜单（新建逻辑▸
//    状态机/行为树、打开编辑器）、双击分发、弹窗挂载（App.vue）。
// 跑法：npm run smoke:fsm
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildContentMenu,
  buildEntryMenu,
  type AssetMenuApi,
} from "../src/app/lib/asset-menu";
import {
  DEFAULT_FSM_GRAPH,
  FSM_EXT,
  cloneFsmGraph,
  evalFsmCondition,
  fsmStateById,
  isFsmAssetRel,
  nextFsmStateId,
  nextFsmStateName,
  nextFsmTransitionId,
  parseFsmGraph,
  FsmRunner,
  type FsmGraph,
} from "../src/framework/fsm";
import {
  BT_EXT,
  BT_NODE_DEFS,
  btCanAcceptChildren,
  btNodeDef,
  btNodeLabel,
  btNodeSummary,
  countBtNodes,
  defaultBehaviorTree,
  findBtNode,
  findBtParent,
  isBtAssetRel,
  nextBtId,
  parseBehaviorTree,
  removeBtNode,
  BTRunner,
  type BTNode,
} from "../src/framework/behavior";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ===========================================================================
console.log("[1] FSM 数据层：parse 收敛 / 助手函数");
{
  // 缺失/非法 → 全默认（单状态 Idle）
  const d = parseFsmGraph(undefined);
  check("parse(undefined) 回退默认图", d.states.length === 1 && d.entry === "s1");
  check("默认图状态为 Idle", d.states[0].name === "Idle");
  check("默认图无过渡无参数", d.transitions.length === 0 && Object.keys(d.params).length === 0);

  // 完整图往返：引用校验、自环剔除、重名去重、参数收敛
  const raw = {
    entry: "a1",
    states: [
      { id: "a1", name: "Patrol", x: 10, y: 20, color: "#4ec9b0" },
      { id: "a2", name: "Patrol", x: -5, y: 99999, color: "nothex" },
      { id: "a3", name: "Chase", x: 30, y: 40 },
    ],
    transitions: [
      { id: "t1", from: "a1", to: "a3", event: "see", duration: 0, conditions: [{ param: "dist", op: "<", value: 10 }] },
      { id: "t2", from: "a1", to: "a1", event: "self" },
      { id: "t3", from: "a1", to: "gone", event: "x" },
      { id: "t1", from: "a3", to: "a1", duration: 2.5 },
      { id: "", from: "a3", to: "a2" },
    ],
    params: { dist: 20, hp: true, junk: "drop" },
  };
  const g = parseFsmGraph(raw);
  check("状态保留 + 重名去重（Patrol → State2）", g.states.length === 3 && g.states[1].name === "State2");
  check("坐标钳制 + 颜色回退", g.states[1].y === 20000 && g.states[1].color === "#569cd6");
  check("过渡剔除自环/悬空/重复 id（剩 2 条）", g.transitions.length === 2);
  check("过渡 id 去重补齐", g.transitions.every((t, i, a) => a.findIndex((x) => x.id === t.id) === i));
  check("参数收敛（丢弃字符串）", g.params.dist === 20 && g.params.hp === true && !("junk" in g.params));

  // 助手函数
  check("nextFsmStateId 避让", nextFsmStateId(g) === "s4" || !g.states.some((s) => s.id === nextFsmStateId(g)));
  check("nextFsmStateName 避让", !g.states.some((s) => s.name === nextFsmStateName(g)));
  check("nextFsmTransitionId 避让", !g.transitions.some((t) => t.id === nextFsmTransitionId(g)));
  check("fsmStateById 命中/未命中", fsmStateById(g, "a3")?.name === "Chase" && fsmStateById(g, "zz") === null);
  check("evalFsmCondition 布尔按 0/1", evalFsmCondition(true, { param: "hp", op: ">=", value: 1 }));
  check("evalFsmCondition 未定义参数不成立", !evalFsmCondition(undefined, { param: "x", op: "==", value: 0 }));
  const c = cloneFsmGraph(g);
  c.states[0].name = "MUT";
  check("cloneFsmGraph 深拷贝", g.states[0].name === "Patrol");
  check("扩展名谓词", isFsmAssetRel("assets/a.FSM") && !isFsmAssetRel("assets/a.bt") && FSM_EXT === ".fsm");
  const empty = parseFsmGraph({ states: [] });
  check("空状态列表回退默认图", empty.states.length === 1 && empty.entry === DEFAULT_FSM_GRAPH.entry);
}

// ===========================================================================
console.log("[2] FSM 求值：触发器 / 链式 / 回调");
{
  const graph: FsmGraph = parseFsmGraph({
    entry: "s1",
    states: [
      { id: "s1", name: "Idle", x: 0, y: 0, color: "" },
      { id: "s2", name: "Walk", x: 100, y: 0, color: "" },
      { id: "s3", name: "Attack", x: 200, y: 0, color: "" },
      { id: "s4", name: "Dead", x: 300, y: 0, color: "" },
    ],
    transitions: [
      { id: "t1", from: "s1", to: "s2", event: "", duration: 1.5, conditions: [] },
      { id: "t2", from: "s2", to: "s3", event: "fire", duration: 0, conditions: [] },
      { id: "t3", from: "s3", to: "s1", event: "", duration: 0, conditions: [{ param: "ammo", op: ">", value: 0 }] },
      { id: "t4", from: "s1", to: "s4", event: "die", duration: 0, conditions: [] },
    ],
    params: { ammo: 0 },
  });
  const log: string[] = [];
  const r = new FsmRunner(graph, {
    onEnter: (s) => log.push(`>${s.name}`),
    onExit: (s) => log.push(`<${s.name}`),
    onTransition: (_f, t) => log.push(`:${t.id}`),
  });
  r.start();
  check("start 进入入口", r.stateName === "Idle" && r.stateTime === 0);

  check("未到时长不过渡", !r.update(0.5) && r.stateName === "Idle");
  check("定时触发（累计 1.5s）", r.update(1.0) && r.stateName === "Walk");
  check("事件未发射不触发", !r.update(1) && r.stateName === "Walk");
  r.fire("fire");
  check("事件触发", r.update(0.016) && r.stateName === "Attack");
  check("条件不满足不触发", !r.update(1) && r.stateName === "Attack");
  r.setParam("ammo", 3);
  check("条件满足触发并回 Idle", r.update(0.016) && r.stateName === "Idle");
  check("进入状态清空事件（die 为旧事件不残留）", (() => {
    r.fire("die");
    r.forceState("s3");
    r.fire("die");
    return r.stateName === "Attack";
  })());
  r.forceState("s1");
  // 链式即时过渡：attack 后立即 ammo>0 回 idle（一帧内 t2 不满足 fire，t3 直接满足）
  r.setParam("ammo", 1);
  r.forceState("s3");
  check("链式即时过渡一帧回 Idle", r.update(0.016) && r.stateName === "Idle");
  check("reset 回未启动", (r.reset(), !r.started && r.stateName === ""));

  const r2 = new FsmRunner(graph);
  r2.start();
  r2.fire("die");
  r2.update(0.016);
  check("事件优先于定时（同帧多出边按顺序）", r2.stateName === "Dead");
  check("生命周期回调序列", (() => {
    const events: string[] = [];
    const rr = new FsmRunner(graph, {
      onEnter: (s) => events.push(`+${s.id}`),
      onExit: (s) => events.push(`-${s.id}`),
    });
    rr.start();
    rr.update(2);
    return events.join(",") === "+s1,-s1,+s2";
  })());
}

// ===========================================================================
console.log("[3] BT 数据层：注册表 / parse 收敛 / 助手");
{
  check("注册表覆盖三类", BT_NODE_DEFS.filter((d) => d.category === "composite").length === 3
    && BT_NODE_DEFS.some((d) => d.type === "selector" && d.maxChildren === -1)
    && BT_NODE_DEFS.some((d) => d.type === "invert" && d.maxChildren === 1)
    && BT_NODE_DEFS.some((d) => d.type === "wait" && d.maxChildren === 0));

  const raw = {
    id: "n1",
    type: "sequence",
    name: "战斗",
    children: [
      { id: "n2", type: "condition", param: "hp", op: "~", value: -5 },
      { id: "n3", type: "action", action: "shoot", children: [{ id: "n4", type: "wait" }] },
      { id: "n5", type: "mystery", children: [] },
      { id: "n6", type: "invert", children: [{ id: "n7", type: "wait", seconds: 3 }, { id: "n8", type: "wait", seconds: 9 }] },
    ],
  };
  const t = parseBehaviorTree(raw) as BTNode;
  check("根保留 + 名称保留", t.type === "sequence" && t.name === "战斗");
  check("非法 op 回退 >=（value 允许负值）", (t.children[0].op as string) === ">=" && t.children[0].value === -5);
  check("叶子节点子树剔除", t.children[1].children.length === 0);
  check("未知类型整枝剔除", t.children.length === 3);
  check("装饰子节点数裁剪", t.children[2].type === "invert" && t.children[2].children.length === 1);
  check("未知类型 parse 返回 null", parseBehaviorTree({ type: "nope" }) === null);
  check("空输入 parse 返回 null", parseBehaviorTree(null) === null);

  const def = defaultBehaviorTree();
  check("默认树：顺序 + 动作 + 等待", def.type === "sequence" && def.children.length === 2
    && def.children[0].type === "action" && def.children[1].type === "wait");
  check("countBtNodes / nextBtId", countBtNodes(def) === 3 && !findBtNode(def, nextBtId(def)));
  check("findBtParent / btNodeDef", findBtParent(def, "nx") === null
    && findBtParent(def, def.children[0].id) === def);
  check("btCanAcceptChildren", btCanAcceptChildren(def) && !btCanAcceptChildren(def.children[0]));
  check("btNodeLabel / btNodeSummary", btNodeLabel(def.children[1]) === "等待"
    && btNodeSummary({ id: "x", type: "wait", seconds: 1.5, children: [] }).includes("1.5s")
    && btNodeSummary({ id: "y", type: "repeat", count: 3, children: [] }).includes("×3"));
  const rt = removeBtNode(def, def.children[0].id);
  check("removeBtNode 移除子节点", rt !== null && rt.children.length === 1);
  check("removeBtNode 移除根返回 null", removeBtNode(def, def.id) === null);
  const cd = parseBehaviorTree(raw) as BTNode;
  cd.children[0].param = "MUT";
  check("深拷贝隔离（parse 即新树）", (t.children[0].param as string) === "hp");
  check("扩展名谓词", isBtAssetRel("a.bt") && !isBtAssetRel("a.fsm") && BT_EXT === ".bt");
}

// ===========================================================================
console.log("[4] BT 求值：组合 / 装饰 / 叶子 / running 记忆");
{
  // 顺序 + running 记忆：wait(0.3) → condition(hp>=1) → action
  const seq = parseBehaviorTree({
    id: "r", type: "sequence",
    children: [
      { id: "w", type: "wait", seconds: 0.3 },
      { id: "c", type: "condition", param: "hp", op: ">=", value: 1 },
      { id: "a", type: "action", action: "hit" },
    ],
  }) as BTNode;
  const runner = new BTRunner(seq);
  const fired: string[] = [];
  runner.onAction = (n) => void fired.push(n.action ?? "");
  const w1 = runner.tick(0.1);
  runner.blackboard.hp = 0;
  const w2 = runner.tick(0.25);
  check("wait running → 条件失败序列失败", w1 === "running" && w2 === "failure");
  runner.reset();
  runner.blackboard.hp = 2;
  const okTick = runner.tick(0.35);
  check("条件通过 → 动作叶子成功", okTick === "success" && fired.includes("hit"));
  check("完成后再 tick 从头开始（wait 又 running）", runner.tick(0.01) === "running");

  // 选择节点：running 记忆（前子失败从运行中的子节点恢复）+ 全失败 + 首子成功
  const sel = parseBehaviorTree({
    id: "s", type: "selector",
    children: [
      { id: "f", type: "condition", param: "see", op: "==", value: 1 },
      { id: "x2", type: "condition", param: "x", op: ">", value: 99 },
      { id: "w2", type: "wait", seconds: 0.2 },
    ],
  }) as BTNode;
  const rs = new BTRunner(sel);
  check("selector 前子失败 → wait running", rs.tick(0.05) === "running");
  check("selector wait 完成后成功（running 记忆恢复）", rs.tick(0.3) === "success");
  rs.blackboard.see = 1;
  check("selector 新周期首子成功", rs.tick(0.01) === "success");
  const selFail = parseBehaviorTree({
    id: "sf", type: "selector",
    children: [
      { id: "c1", type: "condition", param: "see", op: "==", value: 1 },
      { id: "c2", type: "condition", param: "x", op: ">", value: 99 },
    ],
  }) as BTNode;
  check("selector 全失败 → failure", new BTRunner(selFail).tick(0.01) === "failure");

  // 并行：全部成功才成功
  const par = parseBehaviorTree({
    id: "p", type: "parallel",
    children: [
      { id: "w3", type: "wait", seconds: 0.2 },
      { id: "w4", type: "wait", seconds: 0.35 },
    ],
  }) as BTNode;
  const rp = new BTRunner(par);
  check("parallel running", rp.tick(0.1) === "running");
  check("parallel 全部完成后 success", rp.tick(0.3) === "success");

  // 装饰器
  const inv = parseBehaviorTree({
    id: "i", type: "invert",
    children: [{ id: "cc", type: "condition", param: "x", op: ">", value: 5 }],
  }) as BTNode;
  const ri = new BTRunner(inv);
  ri.blackboard.x = 1;
  check("invert 失败转成功", ri.tick(0.01) === "success");
  ri.blackboard.x = 9;
  check("invert 成功转失败", ri.tick(0.01) === "failure");

  const suc = parseBehaviorTree({
    id: "su", type: "succeeder",
    children: [{ id: "cf", type: "condition", param: "x", op: ">", value: 99 }],
  }) as BTNode;
  const rsu = new BTRunner(suc);
  rsu.blackboard.x = 0;
  check("succeeder 强制成功", rsu.tick(0.01) === "success");

  // repeat：count=3，子为即时成功的条件
  const rep = parseBehaviorTree({
    id: "rp", type: "repeat", count: 3,
    children: [{ id: "ok", type: "condition", param: "x", op: ">=", value: 0 }],
  }) as BTNode;
  const rrep = new BTRunner(rep);
  rrep.blackboard.x = 1;
  check("repeat 单帧一轮 running×2 后 success", (() => {
    let st = rrep.tick(0.01);
    if (st !== "running") return false;
    st = rrep.tick(0.01);
    if (st !== "running") return false;
    return rrep.tick(0.01) === "success";
  })());
  // repeat 子失败立即失败
  const repF = parseBehaviorTree({
    id: "rpf", type: "repeat", count: 5,
    children: [{ id: "bad", type: "condition", param: "x", op: ">", value: 100 }],
  }) as BTNode;
  check("repeat 子失败立即失败", new BTRunner(repF).tick(0.01) === "failure");

  // retry：子失败重试，count 次后失败
  const rtry = parseBehaviorTree({
    id: "rt", type: "retry", count: 2,
    children: [{ id: "never", type: "condition", param: "q", op: "==", value: 1 }],
  }) as BTNode;
  const rr2 = new BTRunner(rtry);
  check("retry 重试后失败", (() => {
    const a = rr2.tick(0.01) === "running";
    return a && rr2.tick(0.01) === "failure";
  })());

  // timeout：子 wait 超时失败
  const to = parseBehaviorTree({
    id: "to", type: "timeout", seconds: 0.2,
    children: [{ id: "lw", type: "wait", seconds: 5 }],
  }) as BTNode;
  const rto = new BTRunner(to);
  check("timeout 超时失败", (() => {
    const a = rto.tick(0.15) === "running";
    return a && rto.tick(0.1) === "failure";
  })());

  // action：无处理器默认成功；running 透传
  const act = parseBehaviorTree({ id: "ac", type: "action", action: "open" }) as BTNode;
  const rac = new BTRunner(act);
  check("action 无处理器默认成功", rac.tick(0.01) === "success");
  rac.onAction = () => "running";
  check("action 处理器 running 透传", rac.tick(0.01) === "running");

  // 空树
  check("空树 failure", new BTRunner(null).tick(0.01) === "failure");
}

// ===========================================================================
console.log("[5] 契约：Rust 命令 / api 门面 / 资产菜单 / 双击与弹窗挂载");
{
  const rust = readFileSync(resolve(process.cwd(), "src-tauri/src/scene/logic_assets.rs"), "utf8");
  const libRs = readFileSync(resolve(process.cwd(), "src-tauri/src/lib.rs"), "utf8");
  const modRs = readFileSync(resolve(process.cwd(), "src-tauri/src/scene/mod.rs"), "utf8");
  const apiTs = readFileSync(resolve(process.cwd(), "src/lib/api.ts"), "utf8");
  const menu = readFileSync(resolve(process.cwd(), "src/app/lib/asset-menu.ts"), "utf8");
  const actions = readFileSync(resolve(process.cwd(), "src/app/composables/assets/useAssetItemActions.ts"), "utf8");
  const appVue = readFileSync(resolve(process.cwd(), "src/App.vue"), "utf8");
  const service = readFileSync(resolve(process.cwd(), "src/app/services/assetService.ts"), "utf8");

  check("Rust：fsm_write / behaviortree_write 命令", /pub async fn fsm_write/.test(rust)
    && /pub async fn behaviortree_write/.test(rust));
  check("Rust：扩展名守卫 .fsm / .bt", rust.includes('".fsm"') && rust.includes('".bt"'));
  check("Rust：模块声明与命令注册", /pub mod logic_assets/.test(modRs)
    && /scene::logic_assets::fsm_write/.test(libRs)
    && /scene::logic_assets::behaviortree_write/.test(libRs));
  check("api 门面：fsmWrite / behaviorTreeWrite", /fsm_write/.test(apiTs) && /behaviortree_write/.test(apiTs));
  check("资产菜单：新建逻辑（状态机/行为树）", menu.includes("onNewFsm") && menu.includes("onNewBehaviorTree")
    && /label:\s*"逻辑"/.test(menu));
  check("资产菜单：条目「打开编辑器」", /isFsmAssetRel\(item\.path\) \|\| isBtAssetRel\(item\.path\)/.test(menu));
  check("双击分发：.fsm/.bt 打开编辑器", /isFsmAssetRel/.test(actions) && /isBtAssetRel/.test(actions)
    && /openLogicAssetEditor/.test(actions));
  check("App.vue：两个编辑器弹窗挂载", /FsmEditorDialog/.test(appVue) && /BtEditorDialog/.test(appVue)
    && /logicEditorState/.test(appVue));
  check("assetService：两种资产创建 + 复制目录", /createFsmAsset/.test(service)
    && /createBehaviorTreeAsset/.test(service)
    && /fsm:\s*"assets"/.test(service) && /bt:\s*"assets"/.test(service));

  // 菜单行为验证（桩 API：点击「逻辑 ▸ 状态机」回调携带目录）
  const calls: Record<string, unknown[]> = {};
  const track = (n: string) => (...a: unknown[]) => void (calls[n] = a);
  const menuApi = {
    isInternal: () => false,
    isProtected: () => false,
    isSrcDir: () => false,
    importAllowed: () => true,
    shaderTypes: () => [],
    workshops: () => [],
    onOpenDir: track("onOpenDir"),
    onAddModelToScene: track("onAddModelToScene"),
    onCompressDraco: track("onCompressDraco"),
    onAddAudioToScene: track("onAddAudioToScene"),
    onAddTerrainToScene: track("onAddTerrainToScene"),
    onInstantiatePrefab: track("onInstantiatePrefab"),
    onOpenScript: track("onOpenScript"),
    onOpenLogic: track("onOpenLogic"),
    onCopyInternal: track("onCopyInternal"),
    onCopy: track("onCopy"),
    onRename: track("onRename"),
    onDelete: track("onDelete"),
    onNewScene: track("onNewScene"),
    onNewScript: track("onNewScript"),
    onNewFromWorkshop: track("onNewFromWorkshop"),
    onNewFolder: track("onNewFolder"),
    onNewMaterial: track("onNewMaterial"),
    onNewShader: track("onNewShader"),
    onNewSkybox: track("onNewSkybox"),
    onNewTerrain: track("onNewTerrain"),
    onNewTerrainMaterial: track("onNewTerrainMaterial"),
    onNewFsm: track("onNewFsm"),
    onNewBehaviorTree: track("onNewBehaviorTree"),
    onNewTextureCube: track("onNewTextureCube"),
    onNewPrefab: track("onNewPrefab"),
    onNewAnim: track("onNewAnim"),
    onImport: track("onImport"),
    onImportFolder: track("onImportFolder"),
    onCopyPath: track("onCopyPath"),
    onRefresh: track("onRefresh"),
  } as Parameters<typeof buildContentMenu>[1];
  const items = buildContentMenu("assets", menuApi);
  const logic = items.find((i) => i.label === "逻辑") as { label: string; children: { label: string; onClick: () => void }[] } | undefined;
  check("内容菜单含「逻辑」子菜单", !!logic && logic.children.length === 2);
  logic?.children.find((c) => c.label === "状态机")?.onClick();
  logic?.children.find((c) => c.label === "行为树")?.onClick();
  check("子菜单点击回调 onNewFsm/onNewBehaviorTree 携带目录", Array.isArray(calls.onNewFsm) && calls.onNewFsm[0] === "assets"
    && Array.isArray(calls.onNewBehaviorTree) && calls.onNewBehaviorTree[0] === "assets");
  const entry = buildEntryMenu(
    { name: "a.fsm", path: "assets/a.fsm", kind: "fsm", size: 0, relPath: "a.fsm" },
    menuApi,
  );
  const open = entry.find((i) => i.label === "打开编辑器");
  open?.onClick();
  check("条目菜单「打开编辑器」回调 onOpenLogic", Array.isArray(calls.onOpenLogic));
}

// ===========================================================================
console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
