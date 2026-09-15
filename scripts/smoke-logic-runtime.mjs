// ---------------------------------------------------------------------------
// 逻辑运行器「网页运行时」冒烟（Node 直接运行，不经打包）：
// 验证 public/engine/runtime/logic.mjs 与 tve SDK 的 engine.logic 接线：
//   ① createLogic：场景表收集 fsmRunnerNode/btRunnerNode、.fsm/.bt 资产经
//      resourceLoader（AssetBundle 内存包）读取、信封解包、autoStart 自动开始；
//   ② 状态机：事件过渡（api.fire）、条件过渡（setFsmParam）、定时过渡（speed
//      倍率）、forceState、restart、暂停/恢复、onFsmEnter/Exit/Transition 回调；
//   ③ 行为树：tick 状态（wait running → success）、黑板条件、onAction 处理器
//      （running 续行 + session.seq 重启自增）、restart 清黑板、btStatus；
//   ④ SDK：installRuntime 注入后 engine.logic 按实体寻址（fire/参数/回调/
//      onAction），与 logic.mjs 直调同语义；解绑函数生效。
// 运行：npm run smoke:logic-runtime
// ---------------------------------------------------------------------------

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

let passed = 0;
let failed = 0;
function ok(label, cond) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

const root = resolve(import.meta.dirname, "..");
const engine = (rel) => pathToFileURL(resolve(root, "public/engine", rel)).href;

// —— 最小 DOM 垫片（log.mjs / input 安装期的 window 访问）——
globalThis.window ??= globalThis;
globalThis.window.addEventListener ??= () => {};
globalThis.window.removeEventListener ??= () => {};
globalThis.document ??= { createElement: () => ({ style: {}, getContext: () => null }) };
globalThis.self ??= globalThis;

const { resourceLoader } = await import(engine("runtime/resource.mjs"));
const { AssetBundle } = await import(engine("runtime/asset-bundle.mjs"));
const { createLogic } = await import(engine("runtime/logic.mjs"));

// —— 资产（信封形状，与后端序列化一致）——
const FSM_DOC = JSON.stringify({
  $type: "fsm", $ver: 1, name: "Enemy",
  graph: {
    entry: "s1",
    states: [
      { id: "s1", name: "Idle", x: 0, y: 0, color: "" },
      { id: "s2", name: "Walk", x: 100, y: 0, color: "" },
    ],
    transitions: [
      { id: "t1", from: "s1", to: "s2", event: "go", duration: 0, conditions: [] },
      { id: "t2", from: "s2", to: "s1", event: "", duration: 0.2, conditions: [] },
    ],
    params: { speed: 0 },
  },
});
const BT_DOC = JSON.stringify({
  $type: "behaviortree", $ver: 1, name: "Patrol",
  tree: {
    id: "n1", type: "sequence", children: [
      { id: "n2", type: "action", action: "step", children: [] },
      { id: "n3", type: "condition", param: "ready", op: ">", value: 0, children: [] },
      { id: "n4", type: "wait", seconds: 0.1, children: [] },
    ],
  },
});

resourceLoader.setBundle(AssetBundle.fromMap(new Map([
  ["assets/logic/Enemy.fsm", new TextEncoder().encode(FSM_DOC)],
  ["assets/logic/Patrol.bt", new TextEncoder().encode(BT_DOC)],
])));

// —— 场景表（文档序；与 buildSceneTree 的 nodes 注册表同形状）——
const nodes = [
  { json: { id: "root", type: "node" }, obj: { name: "root" } },
  { json: { id: "r1", type: "fsmRunnerNode", settings: { asset: "assets/logic/Enemy.fsm", autoStart: true, speed: 2 } }, obj: { name: "F1" } },
  { json: { id: "r2", type: "btRunnerNode", settings: { asset: "assets/logic/Patrol.bt", autoStart: true, speed: 1 } }, obj: { name: "B1" } },
];

console.log("[1] createLogic：收集 + 资产加载 + autoStart");
const logic = await createLogic({ nodes });
await new Promise((r) => setTimeout(r, 0)); // 资产异步读取
ok("状态机就绪并自动开始（入口 Idle）", logic.fsmStateOf("r1")?.name === "Idle");
logic.update(0.001); // BT 首轮 tick（未注册动作成功 → ready 条件缺省失败）
ok("未注册动作的 BT 可 tick（ready 条件缺省失败）", logic.btStatusOf("r2") === "failure");
ok("非运行器节点查询安全（null）", logic.fsmStateOf("root") === null && logic.btStatusOf("root") === null);

console.log("[2] 状态机：事件/条件/定时过渡 + 回调 + 控制");
{
  const events = [];
  const offT = logic.onFsmTransition("r1", (from, to) => events.push(`${from.name}->${to.name}`));
  let enterWalk = 0;
  const offE = logic.onFsmEnter("r1", "Walk", () => { enterWalk++; });

  logic.fire("r1", "go");
  logic.update(0.016);
  ok("事件过渡（fire → tick）", logic.fsmStateOf("r1")?.name === "Walk");
  ok("onFsmEnter 按 state 名匹配", enterWalk === 1);
  ok("onFsmTransition 回调（from/to 快照）", events.includes("Idle->Walk"));

  // 定时过渡（t2: 0.2s；speed=2 → 实际 0.1s 即触发）
  logic.update(0.06);
  ok("speed 倍率下定时未到不切换", logic.fsmStateOf("r1")?.name === "Walk");
  logic.update(0.06); // 状态内累计 0.24s × speed2 = 0.48 ≥ 0.2
  ok("speed 倍率定时过渡（Walk → Idle）", logic.fsmStateOf("r1")?.name === "Idle");
  ok("过渡回调序列完整", events[0] === "Idle->Walk" && events[1] === "Walk->Idle");
  offT();
  offE();

  logic.setFsmParam("r1", "speed", 5);
  ok("getFsmParam 读回", logic.getFsmParam("r1", "speed") === 5);
  logic.forceState("r1", "Walk");
  ok("forceState（按状态名）", logic.fsmStateOf("r1")?.name === "Walk");
  logic.restart("r1");
  ok("restart（回入口 + 黑板回默认）", logic.fsmStateOf("r1")?.name === "Idle" && logic.getFsmParam("r1", "speed") === 0);

  logic.setRunning("r1", false);
  logic.update(10);
  ok("暂停：update 不推进", logic.fsmStateOf("r1")?.time === 0);
  logic.setRunning("r1", true);
  logic.update(0.016);
  ok("恢复运行（未启动则从入口开始）", logic.fsmStateOf("r1")?.name === "Idle");

  let exitIdle = 0;
  const offX = logic.onFsmExit("r1", "Idle", () => { exitIdle++; });
  logic.fire("r1", "go");
  logic.update(0.016);
  ok("onFsmExit 回调", exitIdle === 1);
  offX();
}

console.log("[3] 行为树：黑板条件 + onAction running 续行 + 会话重启");
{
  let calls = 0;
  let lastSeq = 0;
  const seqs = [];
  logic.onAction("r2", "step", (leaf, session) => {
    calls++;
    if (session.seq !== lastSeq) { lastSeq = session.seq; seqs.push(session.seq); }
    // 每 3 次调用成功一次
    return calls % 3 === 0 ? "success" : "running";
  });
  // 注意顺序：restart 清黑板 → ready 在 restart 之后写入
  logic.restart("r2");
  logic.setBtParam("r2", "ready", 1);
  logic.update(0.001);
  ok("动作 running → 整树 running", logic.btStatusOf("r2") === "running");
  logic.update(0.001);
  ok("动作续行（第 3 次调用成功）", logic.btStatusOf("r2") === "running" && calls === 2);
  logic.update(0.001);
  // greet 成功 → ready 条件成功 → wait 0.1s running
  ok("动作成功后推进到 wait（整树 running）", logic.btStatusOf("r2") === "running" && calls === 3);
  logic.update(0.12);
  ok("wait 到时 → 整树 success（repeat 无 → 完成）", logic.btStatusOf("r2") === "success");
  ok("会话 seq 初始为 1", seqs[0] === 1);

  // 整树成功后记忆重置：下一轮从头 → 动作重启 → session.seq 自增
  logic.update(0.001);
  ok("树完成后的下一轮重启动作（session.seq 自增）", seqs.includes(2));

  logic.setBtParam("r2", "ready", 0);
  ok("getBtParam 读回", logic.getBtParam("r2", "ready") === 0);
  logic.restart("r2");
  ok("BT restart 清黑板", logic.getBtParam("r2", "ready") === undefined);
}

console.log("[4] SDK：engine.logic 按实体寻址");
{
  const tve = await import(engine("core/tve.mjs"));
  const { installRuntime } = tve;
  installRuntime({
    registry: nodes.map(({ json }) => ({ json, obj: null })),
    rootObj: null,
    canvas: null,
    animations: null,
    audios: null,
    physics: null,
    clipAnims: null,
    particles: null,
    terrains: null,
    ui: null,
    logic,
    scripts: { spawn: () => null },
  });
  ok("engine.logic 已装配", typeof tve.engine.logic.fire === "function");

  const entity = { id: "r1" };
  ok("engine.logic.fsmState（按实体寻址）", tve.engine.logic.fsmState(entity)?.name === "Idle");
  tve.engine.logic.fire(entity, "go");
  logic.update(0.016);
  ok("engine.logic.fire 生效（状态切换）", tve.engine.logic.fsmState(entity)?.name === "Walk");

  let entered = 0;
  const off = tve.engine.logic.onFsmEnter(entity, "Idle", () => { entered++; });
  tve.engine.logic.forceFsmState(entity, "Idle");
  ok("engine.logic.forceFsmState + onFsmEnter", entered === 1);
  off();
  tve.engine.logic.forceFsmState(entity, "Walk");
  ok("解绑函数生效（不再回调）", entered === 1);

  const btEntity = { id: "r2" };
  tve.engine.logic.setBtParam(btEntity, "ready", 3);
  ok("engine.logic.setBtParam/getBtParam", tve.engine.logic.getBtParam(btEntity, "ready") === 3);
  let handled = 0;
  const offA = tve.engine.logic.onAction(btEntity, "step", () => { handled++; });
  tve.engine.logic.restart(btEntity);
  logic.update(0.001);
  ok("engine.logic.onAction 生效（动作被注册的处理器接管）", handled === 1);
  offA();

  // 宿主缺 logic（未注入）时 SDK 安全空转
  installRuntime({
    registry: [], rootObj: null, canvas: null, animations: null, audios: null,
    physics: null, clipAnims: null, particles: null, terrains: null, ui: null,
    logic: null, scripts: { spawn: () => null },
  });
  ok("宿主无 logic：engine.logic 安全空转（返回 null/空函数）",
    tve.engine.logic.fsmState(entity) === null && typeof tve.engine.logic.fire(entity, "x") === "undefined");
}

logic.dispose();
console.log(failed === 0 ? `\n全部通过（${passed} 项）` : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
