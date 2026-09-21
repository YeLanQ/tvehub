// ---------------------------------------------------------------------------
// @priority P0
// 逻辑运行器引擎侧冒烟（headless，无需 GPU）：状态机/行为树的引擎落地。
// 覆盖五段：
// ① 数据层：运行器设置 parse 收敛（资产扩展名校验/speed 钳制/autoStart）、
//    资产信封解包（unwrapLogicAsset）、设置签名；
// ② 节点层：注册表登记、工厂产出、toJSON→createFromJSON 往返（settings 保留）、
//    clone 深拷贝、非法绑定收敛；
// ③ LogicSystem：无 fetcher 绑定降级（assetMissing）、资产加载建求值器、
//    autoStart 自动开始、事件/定时/条件过渡、forceState、restart（黑板回默认）、
//    运行开关、资产热重建（invalidateAsset）、unbind/unbindAll、
//    BT（tick 状态/黑板/动作记录/视图副本）；
// ④ 契约：SCRIPT_NODE_BASE 登记（漏登记编译报错机制）、层级菜单（逻辑分组 →
//    node.add kind logic → 注册表闭环）、nodeCommands 分支、引擎接线
//    （logic.update/sync/unbind/rebuildAll/addFsmRunner）、检查器两卡、
//    层级图标、播放器/SDK 接线、导出收集器、统一入口动态注册。
// 运行：pnpm smoke logic-engine
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_FSM_RUNNER_SETTINGS,
  LOGIC_RUNNER_LIMITS,
  cloneLogicRunnerSettings,
  logicRunnerSettingsSig,
  parseLogicRunnerSettings,
  unwrapLogicAsset,
} from "../../../src/framework/logic";
import { LogicSystem } from "../../../src/framework/logic/LogicSystem";
import { FSM_EXT, isFsmAssetRel } from "../../../src/framework/fsm";
import { BT_EXT, isBtAssetRel } from "../../../src/framework/behavior";
import { createDefaultRegistry } from "../../../src/framework/prototype/PrototypeRegistry";
import { NodeFactory } from "../../../src/framework/factory/NodeFactory";
import { BtRunnerNode, FsmRunnerNode } from "../../../src/framework/prototype/derived/Primitives";
import { addNodeArgs, addNodeMenuItems, collectAddMenuTypes } from "../../../src/app/lib/node-menu";
import { createSuite } from "../harness.mjs";

const { check, finish } = createSuite();

/** 测试资产文本（信封形状，与后端 fsm_write/behaviortree_write 序列化一致） */
const FSM_DOC = JSON.stringify({
  $type: "fsm",
  $ver: 1,
  name: "Enemy",
  graph: {
    entry: "s1",
    states: [
      { id: "s1", name: "Idle", x: 0, y: 0, color: "" },
      { id: "s2", name: "Walk", x: 100, y: 0, color: "" },
    ],
    transitions: [
      // 事件过渡：进入 s1 后 fire("go") 触发
      { id: "t1", from: "s1", to: "s2", event: "go", duration: 0, conditions: [] },
      // 条件过渡：speed 参数 > 0.5 触发
      { id: "t2", from: "s2", to: "s1", event: "", duration: 0, conditions: [{ param: "speed", op: ">", value: 0.5 }] },
      // 定时过渡：s1 停留 1s 触发（出边按定义顺序，事件过渡优先命中）
      { id: "t3", from: "s1", to: "s2", event: "", duration: 1, conditions: [] },
    ],
    params: { speed: 0, hp: 100 },
  },
});

const BT_DOC = JSON.stringify({
  $type: "behaviortree",
  $ver: 1,
  name: "Patrol",
  tree: {
    id: "n1",
    type: "sequence",
    children: [
      { id: "n2", type: "action", action: "greet", children: [] },
      { id: "n3", type: "condition", param: "ready", op: ">", value: 0, children: [] },
      { id: "n4", type: "wait", seconds: 0.3, children: [] },
    ],
  },
});

/** 内存 fetcher（rel → 文本） */
function memoryFetcher(files: Record<string, string>): (rel: string) => Promise<string | null> {
  return async (rel) => files[rel] ?? null;
}

/** 微任务排空（invalidateAsset 的异步重读在下一个宏任务前完成） */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const OBJ = () => ({ uuid: `u${Math.random().toString(36).slice(2)}` }) as never;

async function main(): Promise<void> {
  // =========================================================================
  console.log("[1] 数据层：设置 parse 收敛 / 信封解包 / 签名");
  {
    check("默认设置齐全（3 字段）", Object.keys(DEFAULT_FSM_RUNNER_SETTINGS).length === 3);
    const p = parseLogicRunnerSettings(undefined, ".fsm");
    check("parse(undefined) 回退默认（未绑定）", JSON.stringify(p) === JSON.stringify(DEFAULT_FSM_RUNNER_SETTINGS));
    check("资产扩展名校验（.fsm）", parseLogicRunnerSettings({ asset: "a.bt" }, ".fsm").asset === "");
    check("资产扩展名校验（.bt）", parseLogicRunnerSettings({ asset: "a.fsm" }, ".bt").asset === "");
    check("speed 钳进取值域", parseLogicRunnerSettings({ speed: 999 }, ".fsm").speed === LOGIC_RUNNER_LIMITS.speed.max
      && parseLogicRunnerSettings({ speed: 0 }, ".fsm").speed === LOGIC_RUNNER_LIMITS.speed.min);
    check("autoStart 布尔收敛（缺省 true）", parseLogicRunnerSettings({ autoStart: false }, ".fsm").autoStart === false
      && parseLogicRunnerSettings({}, ".fsm").autoStart === true);
    check("签名逐字段变化", (() => {
      const a = logicRunnerSettingsSig(DEFAULT_FSM_RUNNER_SETTINGS);
      const b = logicRunnerSettingsSig({ ...DEFAULT_FSM_RUNNER_SETTINGS, asset: "a.fsm" });
      const c = logicRunnerSettingsSig({ ...DEFAULT_FSM_RUNNER_SETTINGS, autoStart: false });
      const d = logicRunnerSettingsSig({ ...DEFAULT_FSM_RUNNER_SETTINGS, speed: 2 });
      return a !== b && a !== c && a !== d;
    })());
    check("clone 深拷贝", (() => {
      const c = cloneLogicRunnerSettings({ ...DEFAULT_FSM_RUNNER_SETTINGS, asset: "x.fsm" });
      c.asset = "y.fsm";
      return c.asset === "y.fsm" && DEFAULT_FSM_RUNNER_SETTINGS.asset === "";
    })());
    check("信封解包（.fsm 取 graph / .bt 取 tree）", (() => {
      const g = unwrapLogicAsset(JSON.parse(FSM_DOC), "fsm") as { entry?: string };
      const t = unwrapLogicAsset(JSON.parse(BT_DOC), "bt") as { id?: string };
      return g.entry === "s1" && t.id === "n1";
    })());
    check("裸图/裸树原样返回（容忍非信封）", (() => {
      const bare = { entry: "s1", states: [] };
      return (unwrapLogicAsset(bare, "fsm") as typeof bare) === bare;
    })());
    check("扩展名判断助手", isFsmAssetRel("assets/Enemy.FSM") && isBtAssetRel("a.bt")
      && !isFsmAssetRel("a.bt") && FSM_EXT === ".fsm" && BT_EXT === ".bt");
  }

  // =========================================================================
  console.log("[2] 节点层：注册表 / 工厂 / 序列化往返");
  {
    const registry = createDefaultRegistry();
    const factory = new NodeFactory(registry);
    check("注册表登记 fsmRunnerNode/btRunnerNode", registry.has("fsmRunnerNode") && registry.has("btRunnerNode"));
    const fsm = factory.createFsmRunner();
    check("工厂产出 FsmRunnerNode + 默认名", fsm instanceof FsmRunnerNode && fsm.name === "FSM Runner");
    const bt = factory.createBtRunner({ name: "AI 树" });
    check("工厂产出 BtRunnerNode + 命名", bt instanceof BtRunnerNode && bt.name === "AI 树");

    fsm.settings = parseLogicRunnerSettings({ asset: "assets/logic/Enemy.fsm", autoStart: false, speed: 2.5 }, ".fsm");
    const json = fsm.toJSON() as { type: string; settings?: unknown };
    check("toJSON 携带 type + settings", json.type === "fsmRunnerNode"
      && parseLogicRunnerSettings(json.settings, ".fsm").asset === "assets/logic/Enemy.fsm");
    const restored = factory.fromJSON(JSON.parse(JSON.stringify(json)) as never);
    check("createFromJSON 往返（FsmRunnerNode）", restored instanceof FsmRunnerNode
      && (restored as FsmRunnerNode).settings.asset === "assets/logic/Enemy.fsm"
      && (restored as FsmRunnerNode).settings.speed === 2.5
      && (restored as FsmRunnerNode).settings.autoStart === false);

    bt.settings = parseLogicRunnerSettings({ asset: "assets/logic/Patrol.bt" }, ".bt");
    const btJson = bt.toJSON() as { type: string };
    const btRestored = factory.fromJSON(JSON.parse(JSON.stringify(btJson)) as never);
    check("createFromJSON 往返（BtRunnerNode）", btRestored instanceof BtRunnerNode
      && (btRestored as BtRunnerNode).settings.asset === "assets/logic/Patrol.bt");

    const cloned = fsm.clone() as FsmRunnerNode;
    check("clone 深拷贝（改副本不动本体）", cloned.settings.asset === fsm.settings.asset
      && (() => {
        cloned.settings.asset = "other.fsm";
        return fsm.settings.asset === "assets/logic/Enemy.fsm";
      })());

    // 残缺数据收敛：非法扩展名清空（= 未绑定）+ speed 钳制
    const bad = factory.fromJSON({ type: "fsmRunnerNode", id: "x1", settings: { asset: "a.bt", speed: 1e9 } } as never) as FsmRunnerNode;
    check("旧/非法数据收敛（扩展名不符清空 + speed 钳制）", bad.settings.asset === ""
      && bad.settings.speed === LOGIC_RUNNER_LIMITS.speed.max);
  }

  // =========================================================================
  console.log("[3] LogicSystem：绑定 / 推进 / 控制 / 热重建");
  {
    const system = new LogicSystem();
    const files: Record<string, string> = { "assets/logic/Enemy.fsm": FSM_DOC, "assets/logic/Patrol.bt": BT_DOC };
    let changes = 0;
    system.onChange = () => { changes++; };

    const factory = new NodeFactory(createDefaultRegistry());
    const fsmNode = factory.createFsmRunner({ name: "F1" });
    fsmNode.settings = parseLogicRunnerSettings({ asset: "assets/logic/Enemy.fsm" }, ".fsm");

    // —— 未注入 fetcher：绑定降级（assetMissing），不抛错 ——
    system.syncFsm(fsmNode, OBJ());
    const v0 = system.getFsmView(fsmNode.id);
    check("无 fetcher：绑定空转（assetMissing + 不就绪）", !!v0 && v0.bound && v0.assetMissing && !v0.ready);

    // —— 注入 fetcher → 重新同步 → 加载建求值器 ——
    system.setFetcher(memoryFetcher(files));
    system.syncFsm(fsmNode, OBJ());
    await flush();
    const v1 = system.getFsmView(fsmNode.id);
    check("资产加载建求值器（就绪 + 图规模 + autoStart 自动开始）", !!v1 && v1.ready && v1.started
      && v1.stateCount === 2 && v1.transitionCount === 3 && v1.stateName === "Idle");
    check("黑板初始为图默认值", !!v1 && v1.params.hp === 100 && v1.params.speed === 0);

    // —— 事件过渡：fire("go") → update → 切到 Walk ——
    system.fireFsmEvent(fsmNode.id, "go");
    system.update(0.016);
    const v2 = system.getFsmView(fsmNode.id);
    check("事件过渡（fire → update → 切换）", !!v2 && v2.stateName === "Walk" && !!v2.lastTransition
      && v2.lastTransition.from === "Idle" && v2.lastTransition.to === "Walk");

    // —— 条件过渡：写参数 speed>0.5 → 切回 Idle ——
    system.setFsmParam(fsmNode.id, "speed", 1);
    system.update(0.016);
    check("条件过渡（setFsmParam 满足比较式）", system.getFsmView(fsmNode.id)?.stateName === "Idle");

    // —— 定时过渡：清条件（speed 归零）后仅靠 1s 定时（duration 过渡）——
    system.setFsmParam(fsmNode.id, "speed", 0);
    system.update(0.9);
    check("定时未到不切换", system.getFsmView(fsmNode.id)?.stateName === "Idle");
    system.update(0.2); // 累计 1.1 ≥ 1
    check("定时到切换（duration 过渡）", system.getFsmView(fsmNode.id)?.stateName === "Walk");

    // —— restart：状态回入口、黑板回默认 ——
    system.setFsmParam(fsmNode.id, "hp", 1);
    system.restart(fsmNode.id);
    const v3 = system.getFsmView(fsmNode.id);
    check("restart（状态回入口 + 黑板回默认）", !!v3 && v3.stateName === "Idle" && v3.params.hp === 100);

    // —— 运行开关：暂停后 update 不推进 ——
    system.setRunning(fsmNode.id, false);
    system.update(5);
    check("暂停：update 不推进（停留时长冻结）", system.getFsmView(fsmNode.id)?.stateTime === 0);
    system.setRunning(fsmNode.id, true);
    check("恢复运行", system.getFsmView(fsmNode.id)?.running === true);

    // —— forceState：不经触发器直接切换 ——
    system.forceFsmState(fsmNode.id, "s2");
    check("forceState（按 id 强制切换）", system.getFsmView(fsmNode.id)?.stateName === "Walk");
    check("fsmGraph 提供状态列表（检查器下拉）", (system.fsmGraph(fsmNode.id)?.states.length ?? 0) === 2);

    // —— 热重建：资产文本变化 → invalidateAsset → 图重读（运行开关保持）——
    system.restart(fsmNode.id);
    files["assets/logic/Enemy.fsm"] = FSM_DOC.replace('"Idle"', '"Standby"');
    system.invalidateAsset("assets/logic/Enemy.fsm");
    await flush();
    const v4 = system.getFsmView(fsmNode.id);
    check("热重建：改名后的状态生效（不必重开场景）", !!v4 && v4.ready && v4.stateName === "Standby");
    check("热重建：运行开关保持（仍 started）", !!v4 && v4.started);

    // —— 换绑资产：.fsm → .bt 同一节点不允许（按 kind 绑定），换 rel 重建 ——
    files["assets/logic/Enemy.fsm"] = FSM_DOC;
    system.invalidateAsset("assets/logic/Enemy.fsm");
    await flush();
    check("热重建：还原资产文本", system.getFsmView(fsmNode.id)?.stateName === "Idle");

    // —— BT：绑定 → tick 状态 / 黑板 / 动作记录 ——
    const btNode = factory.createBtRunner({ name: "B1" });
    btNode.settings = parseLogicRunnerSettings({ asset: "assets/logic/Patrol.bt" }, ".bt");
    system.syncBt(btNode, OBJ());
    await flush();
    const bv1 = system.getBtView(btNode.id);
    check("BT 绑定就绪（节点数 = 4）", !!bv1 && bv1.ready && bv1.nodeCount === 4);
    system.setBtParam(btNode.id, "ready", 1);
    system.update(0.1); // greet（成功）→ ready 条件（成功）→ wait 0.3s（running）
    check("BT tick：前两步过、wait running", system.getBtView(btNode.id)?.status === "running");
    check("BT 动作叶子被求值（lastAction 记录）", system.getBtView(btNode.id)?.lastAction === "greet");
    check("BT 黑板视图（副本 + 值）", (() => {
      const bb = system.getBtView(btNode.id)?.blackboard;
      return !!bb && bb.ready === 1;
    })());
    system.update(0.25); // wait 累计 0.35 ≥ 0.3 → 整树成功
    check("BT wait 到时 → 整树 success", system.getBtView(btNode.id)?.status === "success");
    system.restart(btNode.id);
    check("BT restart（黑板清空 + 状态清空待重求值）", (() => {
      const v = system.getBtView(btNode.id);
      return !!v && Object.keys(v.blackboard).length === 0 && v.status === null;
    })());

    // —— 未绑定资产的 BT 视图 / 未知节点视图 ——
    const btBare = factory.createBtRunner({ name: "B2" });
    system.syncBt(btBare, OBJ());
    check("未绑定视图（bound=false，不判缺失）", (() => {
      const v = system.getBtView(btBare.id);
      return !!v && !v.bound && !v.assetMissing && !v.ready;
    })());

    // —— unbind / unbindAll ——
    system.unbind(fsmNode.id);
    check("unbind 后视图为 null", system.getFsmView(fsmNode.id) === null);
    system.syncFsm(fsmNode, OBJ());
    await flush();
    system.unbindAll();
    check("unbindAll 后全部解绑", system.getFsmView(fsmNode.id) === null && system.getBtView(btNode.id) === null);
    check("onChange 全程有回调（事件广播机制活）", changes > 0);
  }

  // =========================================================================
  console.log("[4] 契约：引擎 / 菜单 / 命令 / 检查器 / 图标 / 播放器");
  {
    const registry = createDefaultRegistry();
    const factory = new NodeFactory(registry);
    check("层级菜单：逻辑分组", (() => {
      const items = addNodeMenuItems({ geometry: [], scripts: [] });
      const types = collectAddMenuTypes(items);
      return types.includes("logic:fsm") && types.includes("logic:bt");
    })());
    check("菜单映射：logic:fsm/bt → kind=logic + subtype", (() => {
      const a = addNodeArgs("logic:fsm", "p1");
      const b = addNodeArgs("logic:bt", "p1");
      return a?.kind === "logic" && a.subtype === "fsm" && b?.kind === "logic" && b.subtype === "bt";
    })());
    check("菜单 → 注册表闭环（运行器工厂可用）", registry.has("fsmRunnerNode") && registry.has("btRunnerNode")
      && factory.createFsmRunner() instanceof FsmRunnerNode);

    const nodeCmds = readFileSync(resolve(process.cwd(), "src/app/commands/nodeCommands.ts"), "utf8");
    check("nodeCommands 有 logic 分支", /case "logic":/.test(nodeCmds) && /addFsmRunner/.test(nodeCmds) && /addBtRunner/.test(nodeCmds));

    const engineSrc = readFileSync(resolve(process.cwd(), "src/framework/engine/EditorEngine.ts"), "utf8");
    check("引擎：SCRIPT_NODE_BASE 登记（漏登记编译报错机制）", /fsmRunnerNode: \(e, p\) => e\.addFsmRunner\(p\)/.test(engineSrc)
      && /btRunnerNode: \(e, p\) => e\.addBtRunner\(p\)/.test(engineSrc));
    check("引擎：渲染循环推进 logic", /this\.logic\.update\(dt\)/.test(engineSrc));
    check("引擎：图事件接线（同步/解绑）", /this\.logic\.syncFsm/.test(engineSrc) && /this\.logic\.unbind/.test(engineSrc));
    check("引擎：logic:changed 事件广播", /"logic:changed"/.test(engineSrc));
    check("引擎：整体重建重绑逻辑运行器", (() => {
      const rb = engineSrc.match(/rebuildAll\(\): void \{[\s\S]*?\n  \}/);
      return !!rb && /logic\.unbindAll\(\)/.test(rb[0]) && /logic\.syncFsm\(node, obj\)/.test(rb[0]);
    })());

    const svcSrc = readFileSync(resolve(process.cwd(), "src/app/services/editorService.ts"), "utf8");
    check("应用层：逻辑资产 fetcher 注入（项目打开/切换）", /engine\.logic\.setFetcher/.test(svcSrc));

    const fsmDlg = readFileSync(resolve(process.cwd(), "src/app/components/logic/FsmEditorDialog.vue"), "utf8");
    const btDlg = readFileSync(resolve(process.cwd(), "src/app/components/logic/BtEditorDialog.vue"), "utf8");
    check("编辑器：保存后热重建运行器绑定", /invalidateAsset/.test(fsmDlg) && /invalidateAsset/.test(btDlg));

    const panel = readFileSync(resolve(process.cwd(), "src/app/components/InspectorPanel.vue"), "utf8");
    check("检查器：FSM Runner / BT Runner 卡", /FsmRunnerSection/.test(panel) && /BtRunnerSection/.test(panel));

    const fsmSection = readFileSync(resolve(process.cwd(), "src/app/components/inspector/FsmRunnerSection.vue"), "utf8");
    check("检查器：状态机卡（资产下拉/运行控制/事件/黑板）", /isFsmAssetRel/.test(fsmSection)
      && /fireFsmEvent/.test(fsmSection) && /forceFsmState/.test(fsmSection) && /setFsmParam/.test(fsmSection));

    const btSection = readFileSync(resolve(process.cwd(), "src/app/components/inspector/BtRunnerSection.vue"), "utf8");
    check("检查器：行为树卡（黑板/重启/状态视图）", /isBtAssetRel/.test(btSection)
      && /setBtParam/.test(btSection) && /restart/.test(btSection));

    const hierarchySrc = readFileSync(resolve(process.cwd(), "src/app/components/HierarchyPanel.vue"), "utf8");
    check("层级：逻辑运行器图标登记", /fsmRunnerNode: \{ d: FSM_RUNNER_ICON_PATHS/.test(hierarchySrc)
      && /btRunnerNode: \{ d: BT_RUNNER_ICON_PATHS/.test(hierarchySrc));

    const logicApiSrc = readFileSync(resolve(process.cwd(), "src/runtime/core/tve/logic-api.ts"), "utf8");
    check("SDK：engine.logic 转发层（fire/参数/回调/动作）", /fire/.test(logicApiSrc) && /setFsmParam/.test(logicApiSrc)
      && /onFsmEnter/.test(logicApiSrc) && /onAction/.test(logicApiSrc));

    // 多运行器引用：脚本 @property({ type: FsmRunnerNode }) 的编辑器过滤链路
    const refConstants = readFileSync(resolve(process.cwd(), "src/app/lib/script-compile/constants.ts"), "utf8");
    check("SDK：节点引用过滤登记（检查器按运行器类型列候选）", /FsmRunnerNode: \["fsmRunnerNode"\]/.test(refConstants)
      && /BtRunnerNode: \["btRunnerNode"\]/.test(refConstants));
    const refCompile = readFileSync(resolve(process.cwd(), "src/app/lib/script-compile/compile.ts"), "utf8");
    check("SDK：裸字段类型不误判为脚本组件引用", /"FsmRunnerNode",/.test(refCompile) && /"BtRunnerNode",/.test(refCompile));

    const tveDts = readFileSync(resolve(process.cwd(), "src/framework/scripting/tve.d.ts"), "utf8");
    check("SDK：tve.d.ts 契约同步（EngineApi.logic + 节点类型）", /readonly logic: LogicApi/.test(tveDts)
      && /"fsmRunnerNode"/.test(tveDts) && /"btRunnerNode"/.test(tveDts) && /class FsmRunnerNode/.test(tveDts));

    const scriptsHost = readFileSync(resolve(process.cwd(), "src/runtime/core/scripts.ts"), "utf8");
    check("运行时：脚本宿主注入 logic（engine.logic 转发到 createLogic）", /logic: logic \?\? null/.test(scriptsHost));

    const playerSrc = readFileSync(resolve(process.cwd(), "public/web-preview/player.mjs"), "utf8");
    check("播放器：createLogic 先于脚本宿主 + 帧循环推进", /createLogic\(\{ nodes \}\)/.test(playerSrc)
      && /logicApi\.update\(dt\)/.test(playerSrc));

    const rustMigrate = readFileSync(resolve(process.cwd(), "src-tauri/src/scene/migrate.rs"), "utf8");
    const rustPreview = readFileSync(resolve(process.cwd(), "src-tauri/src/preview.rs"), "utf8");
    check("导出：collect_logic_refs 收集 .fsm/.bt + preview 打包接线", /collect_logic_refs/.test(rustMigrate)
      && /collect_logic_refs/.test(rustPreview));

    const runner = resolve(process.cwd(), "scripts", "smoke", "runner.mjs");
    check("统一入口 runner.mjs 已就位（本脚本由其动态发现）", existsSync(runner));
  }

  finish();
}

void main();
