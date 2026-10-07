// 物理 Worker bundle · node 全链冒烟（构建链内运行；exit code 判定）：
// 伪平台 worker 环境（worker 方法形态全局 + bridge 保留信道的 wasm 字节应答）下
// 驱动产物 bundle 走 physics（init→ready→step→stepped→castRay→dispose）与
// animation（init→ready→play→step→stepped→command→dispose）双 ns 全链——物理引擎
// 以真实 wasm 实例化（读取随包 .wasm 真字节），动画为纯数学代理（免 wasm），
// 消息全程纯数组（与微信拷贝传输同形态），globalThis 不遮蔽（真全局形态；
// rapier 胶水的 wasm-bindgen 借用检查对全局形态敏感）。
//
// 已知环境敏感点（真机验证清单）：胶水对自由标识符 `self` 的存在性敏感——沙箱
// 注入 self 时 rapier 在 world.step 触发 wasm unreachable（jolt/ammo 不受影响）。
// 默认不注入 self（worker 全局必在；self 是否存在/形态如何以真机为准），可用
// WS_MODE=self,window 注入复现。
//
// 用法：node worker-smoke.mjs <bundle> <wasm> <backend>  [WS_MODE=self,window]
import assert from "node:assert";
import fs from "node:fs";

const [bundlePath, wasmPath, backend] = process.argv.slice(2);
if (!bundlePath || !wasmPath || !backend) {
  console.error("用法: node worker-smoke.mjs <bundle> <wasm> <backend>");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 伪平台环境：worker 全局（方法形态；self/window 可经 WS_MODE 注入）+ 上行分发
// ---------------------------------------------------------------------------

let terminated = false;
/** worker.onMessage 注册的下行投递口（主 → worker） */
let downDeliver = null;
/** worker 产物的上行信封队列（worker → 主） */
const upEnvelopes = [];

const workerGlobal = {
  onMessage(cb) {
    downDeliver = cb;
  },
  postMessage(msg) {
    upEnvelopes.push(msg);
  },
  terminate() {
    terminated = true;
  },
};
const selfLike = {
  onmessage: null,
  postMessage(msg) {
    upEnvelopes.push(msg);
  },
};

/** 下行投递（单一单调 seq——与真实主线程 seqCounter 同构；水位去重依赖全序列单调） */
let downSeq = 0;
function sendDown(ns, payload) {
  deliverDown({ ns, seq: ++downSeq, payload });
}
function deliverDown(envelope) {
  if (downDeliver) downDeliver(envelope);
  else if (typeof selfLike.onmessage === "function") selfLike.onmessage({ data: envelope });
  else throw new Error("worker 下行通道未注册");
}

const tick = () => new Promise((r) => setImmediate(r));
async function waitFor(pred, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await tick();
  }
  throw new Error(`worker-smoke 超时等待: ${label}`);
}

// ---------------------------------------------------------------------------
// 产物装载：忠实形态（不遮蔽 globalThis）——真实 worker 线程 = 真全局对象，
// 普通对象遮蔽会让 rapier 胶水的 wasm-bindgen 借用检查误触发 aliasing/
// unreachable 伪影。中继钩子装在真全局上，须存活到全链跑完——本冒烟经
// execFileSync 独立子进程运行（guards.mjs），进程退出即清理。
// ---------------------------------------------------------------------------

const code = fs.readFileSync(bundlePath, "utf8");
const run = new Function(
  "module",
  "exports",
  "require",
  "worker",
  "self",
  "window",
  "console",
  "setTimeout",
  "clearTimeout",
  "process",
  code,
);
// window 桩：createPhysics 内部 postLog 经 window.parent.postMessage 转出（worker 线程无 window）
const windowStub = { parent: { postMessage: (msg) => console.log(`  [postLog:${msg?.level}] ${msg?.text}`) } };
const m = (process.env.WS_MODE || "").split(",");
run({}, {}, () => ({}), workerGlobal, m.includes("self") ? selfLike : undefined, m.includes("window") ? windowStub : undefined, console, setTimeout, clearTimeout, undefined);

// ---------------------------------------------------------------------------
// bridge 保留信道应答：ready 握手 + wasm 字节回传（真字节，base64 形态）
// ---------------------------------------------------------------------------

const wasmB64 = fs.readFileSync(wasmPath).toString("base64");
let gotReady = false;
let wasmServed = 0;

/** 排空上行队列：bridge 信道就地应答（ready 握手 / wasm 真字节回传），物理信封
 *  保留在队列里由调用方断言消费 */
function serveBridge() {
  const physicsBack = [];
  for (const env of upEnvelopes.splice(0)) {
    if (env.ns !== "bridge") {
      physicsBack.push(env);
      continue;
    }
    const p = env.payload || {};
    if (p.t === "ready") {
      gotReady = true;
    } else if (p.t === "wasmReq") {
      wasmServed++;
      sendDown("bridge", { t: "wasmRes", id: p.id, b64: wasmB64 });
    } else if (p.t === "log") {
      console.log(`  [worker] ${p.text}`);
    }
  }
  upEnvelopes.push(...physicsBack);
}

// ---------------------------------------------------------------------------
// 测试场景：静态地面 + 动态方块（box 碰撞体，形状确定不依赖网格烘焙）
// ---------------------------------------------------------------------------

function physNode(id, y, extraComponents) {
  return {
    nodeId: id,
    json: {
      id,
      components: [
        {
          id: `comp-${id}`,
          type: "collider",
          enabled: true,
          collider: {
            shape: "box",
            autoSize: false,
            size: { x: 1, y: 1, z: 1 },
            offset: { x: 0, y: 0, z: 0 },
            friction: 0.6,
            restitution: 0,
          },
        },
        ...extraComponents,
      ],
    },
    position: [0, y, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    parentId: null,
    isMesh: false,
    vertices: null,
  };
}

const nodes = [
  physNode("floor", 0, [
    {
      id: "rb-floor",
      type: "rigidBody",
      enabled: true,
      rigidBody: {
        mode: "static",
        mass: 0,
        linearDamping: 0,
        angularDamping: 0,
        gravityScale: 0,
        ccd: false,
        lockRotation: false,
        upright: false,
      },
    },
  ]),
  physNode("ball", 2, [
    {
      id: "rb-ball",
      type: "rigidBody",
      enabled: true,
      rigidBody: {
        mode: "dynamic",
        mass: 1,
        linearDamping: 0,
        angularDamping: 0,
        gravityScale: 1,
        ccd: false,
        lockRotation: false,
        upright: false,
      },
    },
  ]),
];

// ---------------------------------------------------------------------------
// 全链驱动
// ---------------------------------------------------------------------------

await waitFor(() => downDeliver !== null || typeof selfLike.onmessage === "function", "下行通道注册");
serveBridge();
assert.ok(gotReady, "worker 应在上行发出 ready 握手");

// init 下发（纯数组形态 = 微信拷贝传输口径）
let physicsReady = null;
let initError = null;
deliverDown({
  ns: "physics",
  seq: ++downSeq,
  payload: { type: "init", nodes, terrains: [], settings: { physicsEnabled: true, backend, gravity: { x: 0, y: -9.81, z: 0 } } },
});
await waitFor(
  () => {
    serveBridge();
    for (const e of upEnvelopes.splice(0)) {
      if (e.ns !== "physics") continue;
      if (e.payload.type === "ready") physicsReady = e.payload;
      else if (e.payload.type === "error") initError = e.payload.message;
    }
    return physicsReady || initError;
  },
  "physics ready",
);
assert.ok(physicsReady, `worker init 应成功（initError=${initError ?? "无"}）`);
assert.deepStrictEqual(physicsReady.dynamicIds, ["ball"], "动态体应恰为 ball");
assert.ok(
  physicsReady.bodyInfos && physicsReady.bodyInfos.ball && physicsReady.bodyInfos.ball.mode === "dynamic",
  "bodyInfo 应含 ball/dynamic",
);

// step 驱动：ball 自 y=2 下落（60Hz × 30 步 ≈ 0.5s，足以下落触地）
let lastStepped = null;
for (let i = 0; i < 30; i++) {
  deliverDown({
    ns: "physics",
    seq: ++downSeq,
    payload: {
      type: "step",
      dt: 1 / 60,
      transforms: [0, 0, 0, 0, 0, 0, 1, 0, 2, 0, 0, 0, 0, 1],
    },
  });
  serveBridge();
  for (const e of upEnvelopes.splice(0)) {
    if (e.ns !== "physics") continue;
    if (e.payload.type === "stepped") lastStepped = e.payload;
    else if (e.payload.type === "error") throw new Error(`worker step 失败: ${e.payload.message}`);
  }
  await tick();
}
assert.ok(lastStepped, "step 后应收到 stepped 回包");
assert.ok(Array.isArray(lastStepped.transforms), "拷贝传输下 stepped.transforms 应为纯数组");
const ballY = lastStepped.transforms[1];
assert.ok(typeof ballY === "number" && ballY < 2 && ballY > -1, `ball 应已自 y=2 下落（实测 y=${ballY}）`);
assert.ok(Array.isArray(lastStepped.velocities), "velocities 应为纯数组");

// 射线：自上而下应命中场景（floor / 触地后的 ball）
deliverDown({
  ns: "physics",
  seq: ++downSeq,
  payload: {
    type: "castRay",
    id: 1,
    options: { origin: { x: 0, y: 5, z: 0 }, direction: { x: 0, y: -1, z: 0 }, maxDistance: 50 },
  },
});
await waitFor(() => upEnvelopes.some((e) => e.ns === "physics" && e.payload.type === "raycastResult"), "raycastResult");
serveBridge();
const rayEnv = upEnvelopes.find((e) => e.ns === "physics" && e.payload.type === "raycastResult");
upEnvelopes.length = 0;
assert.ok(Array.isArray(rayEnv.payload.hits), "raycastResult.hits 应为数组");
assert.ok(rayEnv.payload.hits.length >= 1, `向下射线应命中场景（实测 ${rayEnv.payload.hits.length} 命中）`);

// command 通道：setGravity 下发不回包不抛错；dispose 收尾
deliverDown({ ns: "physics", seq: ++downSeq, payload: { type: "command", method: "setGravity", args: [0, -20, 0] } });
serveBridge();
deliverDown({ ns: "physics", seq: ++downSeq, payload: { type: "dispose" } });
serveBridge();

// ---------------------------------------------------------------------------
// 动画路由全链（同一 worker 单例的 animation ns；纯数学无 wasm）：
// init（2 骨骼代理 + 1 剪辑）→ ready（绑定布局）→ play → step → stepped（骨骼
// 变换回写 + 状态镜像）→ command（getWeight 结果回包）→ dispose。消息全程纯数组
// （与微信拷贝传输同口径——track times/values 数组化后 worker 侧重建）
// ---------------------------------------------------------------------------

let animReady = null;
let animError = null;
deliverDown({
  ns: "animation",
  seq: ++downSeq,
  payload: {
    type: "init",
    meshEntries: [
      {
        json: { id: "hero", type: "meshNode", source: "model", model: "hero" },
        modelRoot: {
          bones: [
            { name: "hip", position: [0, 1, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], parentIndex: -1 },
            { name: "tail", position: [0, 0, -1], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], parentIndex: 0 },
          ],
          morphMeshes: [],
        },
      },
    ],
    modelMap: [
      {
        name: "hero",
        clips: [
          {
            name: "idle",
            duration: 2,
            blendMode: 2500, // NormalAnimationBlendMode（serializeClip 数值枚举口径）
            tracks: [
              {
                name: "tail.position",
                times: [0, 1, 2],
                values: [0, 0, -1, 0, 0, -3, 0, 0, -1],
              },
            ],
          },
        ],
      },
    ],
  },
});
await waitFor(
  () => {
    serveBridge();
    for (const e of upEnvelopes.splice(0)) {
      if (e.ns !== "animation") continue;
      if (e.payload.type === "ready") animReady = e.payload;
      else if (e.payload.type === "error") animError = e.payload.message;
    }
    return animReady || animError;
  },
  "animation ready",
);
assert.ok(animReady, `动画 worker init 应成功（error=${animError ?? "无"}）`);
assert.strictEqual(animReady.bindingLayouts?.length, 1, "绑定布局应恰 1 条");
const layout = animReady.bindingLayouts[0];
assert.deepStrictEqual(
  { nodeId: layout.nodeId, boneCount: layout.boneCount, boneNames: layout.boneNames },
  { nodeId: "hero", boneCount: 2, boneNames: ["hip", "tail"] },
  "绑定布局应与 init 骨骼清单一致",
);

// play 命令：返回值 true 经 result 回包（命令通道 + 结果回包双覆盖）
deliverDown({
  ns: "animation",
  seq: ++downSeq,
  payload: { type: "command", method: "play", args: ["hero", "idle"] },
});
await waitFor(
  () => {
    serveBridge();
    return upEnvelopes.some((e) => e.ns === "animation" && e.payload.type === "result" && e.payload.method === "play");
  },
  "play result",
);
upEnvelopes.length = 0;

// step 驱动：30 帧 = 0.5s，tail.position.z 应在 0→1s 关键帧插值的中点（≈-2）
let lastAnimStep = null;
for (let i = 0; i < 30; i++) {
  deliverDown({ ns: "animation", seq: ++downSeq, payload: { type: "step", dt: 1 / 60 } });
  serveBridge();
  for (const e of upEnvelopes.splice(0)) {
    if (e.ns !== "animation") continue;
    if (e.payload.type === "stepped") lastAnimStep = e.payload;
    else if (e.payload.type === "error") throw new Error(`动画 step 失败: ${e.payload.message}`);
  }
  await tick();
}
assert.ok(lastAnimStep, "step 后应收到 stepped 回包");
assert.strictEqual(lastAnimStep.transforms.length, 14, "回写变换应为 2 骨骼 × 7 分量");
const tailZ = lastAnimStep.transforms[9];
assert.ok(
  Math.abs(tailZ - -2) < 0.2,
  `tail.z 应处于关键帧插值中段（实测 ${Number(tailZ).toFixed(3)}，期望 ≈-2）`,
);
assert.ok(
  lastAnimStep.state && lastAnimStep.state.hero && lastAnimStep.state.hero.weights.idle > 0,
  "状态镜像应含 hero/idle 的有效权重",
);

// getWeight 命令：同步读数经 result 回包（null 值也回包）
deliverDown({
  ns: "animation",
  seq: ++downSeq,
  payload: { type: "command", method: "getWeight", args: ["hero", "idle"] },
});
await waitFor(
  () => {
    serveBridge();
    return upEnvelopes.some((e) => e.ns === "animation" && e.payload.type === "result" && e.payload.method === "getWeight");
  },
  "getWeight result",
);
const weightEnv = upEnvelopes.find((e) => e.ns === "animation" && e.payload.method === "getWeight");
upEnvelopes.length = 0;
assert.ok(typeof weightEnv.payload.value === "number" && weightEnv.payload.value > 0, "getWeight 应回有效权重");

// recycleResult（拷贝传输下无 buffer，缓冲池旁路不抛错）+ dispose 收尾
deliverDown({
  ns: "animation",
  seq: ++downSeq,
  payload: { type: "recycleResult", transforms: lastAnimStep.transforms, morphs: lastAnimStep.morphs },
});
deliverDown({ ns: "animation", seq: ++downSeq, payload: { type: "dispose" } });
serveBridge();

console.log(
  `[worker-smoke] PASS ${backend} — ready 握手 ✓ wasm 实例化 ×${wasmServed} ✓ ` +
    `stepped 30 帧（ball y=${Number(ballY).toFixed(3)}）✓ raycast ${rayEnv.payload.hits.length} 命中 ✓ ` +
    `动画 init/ready ✓ stepped 30 帧（tail.z=${Number(tailZ).toFixed(3)}）✓ 命令回包 ×2 ✓`,
);
