// ---------------------------------------------------------------------------
// 粒子系统「网页运行时」冒烟（Node 直接运行，不经打包）：
// 用 scene.json 片段喂给 public/engine/runtime 的场景树构建链路，验证
//   ① particleSystemNode 建为 Group + __particles Points 子对象，收集到 particles 列表，
//      节点层同步到 Points，userData 标记完整；
//   ② 设置收敛与编辑器同语义（缺失/越界/枚举回退）；
//   ③ createParticles 每帧推进：发射速率、容量封顶、不可见宿主不推进、非循环播完、
//      预热首帧接近稳态、world 空间粒子留在原地；
//   ④ 按节点 id 的运行时控制（play/pause/stop/restart/clear/infoOf/updateSettings：
//      非结构参数原地更新、结构参数重建并保留层）；
//   ⑤ 脚本 SDK：tve.mjs 导出 ParticleSystemNode 且 KIND_CLASSES/engine.particles 接线；
//      scripts.mjs 把 particles 注入宿主。
// 运行：npm run smoke:particles-runtime
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}
const approx = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

const root = resolve(import.meta.dirname, "..");
const runtime = (rel) => pathToFileURL(resolve(root, "public/engine/runtime", rel)).href;
const core = (rel) => pathToFileURL(resolve(root, "public/engine/core", rel)).href;

const { buildSceneTree } = await import(runtime("nodes.mjs"));
const { createParticles } = await import(runtime("particles.mjs"));
const { createParticleEmitter, parseParticleSettings, PARTICLES_CHILD_NAME, getParticleSpriteTexture } = await import(
  core("particles.mjs")
);
const THREE = await import(core("three.module.min.js"));

function advance(api, seconds, step = 1 / 60) {
  const n = Math.round(seconds / step);
  for (let i = 0; i < n; i++) api.update(step);
}
/** 等待异步贴图链路落定 */
const tick = () => new Promise((r) => setTimeout(r, 0));

console.log("[1] 场景树建出");
const scene = new THREE.Scene();
const sceneJson = {
  type: "node",
  id: "root",
  name: "Root",
  children: [
    {
      type: "particleSystemNode",
      id: "ps1",
      name: "Sparks",
      layer: 4,
      tag: "fx",
      transform: { position: { x: 1, y: 2, z: 3 } },
      particles: { emissionRate: 120, startLifetime: 1, maxParticles: 300, blending: "normal" },
    },
    {
      type: "particleSystemNode",
      id: "ps-legacy",
      name: "Legacy",
      // 无 particles 字段：旧场景 → 默认设置
    },
    {
      type: "particleSystemNode",
      id: "ps-hidden",
      name: "Hidden",
      visible: false,
      particles: { emissionRate: 100, startLifetime: 5 },
    },
  ],
};
const built = buildSceneTree(sceneJson, scene, { materialParams: new Map(), models: new Map() });
ok(Array.isArray(built.particles) && built.particles.length === 3, "collector 收集 3 个粒子节点");
const entry = built.particles.find((p) => p.json.id === "ps1");
ok(!!entry && entry.obj.isGroup === true, "粒子节点建为 Group");
ok(entry.obj.userData.nodeId === "ps1" && entry.obj.userData.nodeKind === "particleSystemNode", "userData.nodeId / nodeKind 标记");
ok(entry.obj.userData.nodeTag === "fx", "userData.nodeTag 标记");
ok(approx(entry.obj.position.x, 1) && approx(entry.obj.position.y, 2) && approx(entry.obj.position.z, 3), "节点变换落位");
const points = entry.obj.children.find((c) => c.name === PARTICLES_CHILD_NAME);
ok(!!points && points.isPoints === true, "Group 下挂 __particles Points");
ok(points.layers.mask === 1 << 4, "Points 跟随节点层（layer 4）");
ok(entry.emitter && entry.emitter.object === points, "collector 条目携带发射器句柄");
ok(points.material.blending === THREE.NormalBlending, "blending=normal → NormalBlending");
ok(points.material.transparent === true && points.material.depthWrite === false, "材质透明 + 不写深度");
ok(points.frustumCulled === false, "关闭视锥剔除");
ok(points.geometry.getAttribute("position").count === 300, "缓冲容量 = maxParticles");
const legacy = built.particles.find((p) => p.json.id === "ps-legacy");
ok(legacy.emitter.settings.emissionRate === 20 && legacy.emitter.settings.shape === "cone", "旧场景无 particles → 默认设置");

console.log("[2] 设置收敛（与编辑器 parseParticleSystemSettings 同语义）");
{
  const p = parseParticleSettings({
    duration: -5,
    startLifetime: 99999,
    startSpeed: "fast",
    startColor: 0x1ff0000,
    emissionRate: Infinity,
    maxParticles: 3.7,
    shape: "torus",
    shapeAngle: 200,
    simulationSpace: "galaxy",
    blending: "multiply",
    looping: 0,
  });
  ok(p.duration === 0.05, "duration 钳到下限 0.05");
  ok(p.startLifetime === 120, "startLifetime 钳到上限 120");
  ok(p.startSpeed === 3, "非数回默认");
  ok(p.startColor === 0xff0000, "颜色掩 24 位");
  ok(p.emissionRate === 20, "Infinity 回默认");
  ok(p.maxParticles === 4, "maxParticles 取整");
  ok(p.shape === "cone" && p.simulationSpace === "local" && p.blending === "additive", "枚举非法回默认");
  ok(p.looping === true, "非布尔回默认");
  ok(parseParticleSettings({}).texture === "" && parseParticleSettings({ texture: 7 }).texture === "", "texture 缺省/非字符串 → 空串");
  ok(parseParticleSettings({ texture: "assets/textures/spark.png" }).texture === "assets/textures/spark.png", "texture 字符串保留");
}

console.log("[3] createParticles 每帧推进");
const api = createParticles(built.particles);
advance(api, 0.5);
{
  const st = api.infoOf("ps1");
  ok(st && st.alive >= 58 && st.alive <= 61, `0.5s 后约 60 粒子（120/s）: ${st?.alive}`);
  ok(st.playing === true && st.paused === false && st.finished === false, "运行态：播放中");
  ok(points.geometry.drawRange.count === st.alive, "drawRange 跟随存活数");
}
advance(api, 2);
{
  const st = api.infoOf("ps1");
  ok(st.alive >= 116 && st.alive <= 121, `稳态 ≈ rate×lifetime=120: ${st.alive}`);
  ok(api.infoOf("ps-hidden").alive === 0, "不可见宿主不推进（0 粒子）");
  ok(api.infoOf("nope") === null, "未知 id → null");
}
{
  // 容量封顶
  const capApi = createParticles([
    { json: { id: "cap" }, obj: new THREE.Group(), emitter: null },
  ]);
  ok(capApi.infoOf("cap") === null, "无发射器的条目被忽略");
  const host = new THREE.Group();
  const em = createParticleEmitter({ emissionRate: 5000, startLifetime: 10, maxParticles: 40 });
  host.add(em.object);
  const a2 = createParticles([{ json: { id: "c2" }, obj: host, emitter: em }]);
  advance(a2, 1);
  ok(a2.infoOf("c2").alive === 40, "maxParticles 封顶");
}
{
  // 非循环播完
  const host = new THREE.Group();
  const em = createParticleEmitter({ looping: false, duration: 0.5, emissionRate: 100, startLifetime: 0.3, maxParticles: 500 });
  host.add(em.object);
  const a3 = createParticles([{ json: { id: "once" }, obj: host, emitter: em }]);
  advance(a3, 0.4);
  ok(a3.infoOf("once").alive > 0 && !a3.infoOf("once").finished, "发射窗口内有粒子");
  advance(a3, 1.5);
  ok(a3.infoOf("once").alive === 0 && a3.infoOf("once").finished === true, "非循环：播完 finished");
  a3.play("once");
  ok(a3.infoOf("once").time === 0 && !a3.infoOf("once").finished, "play 从头开始");
}
{
  // 预热
  const host = new THREE.Group();
  const em = createParticleEmitter({ prewarm: true, looping: true, duration: 3, emissionRate: 50, startLifetime: 2, maxParticles: 500 });
  host.add(em.object);
  const a4 = createParticles([{ json: { id: "warm" }, obj: host, emitter: em }]);
  a4.update(1 / 60);
  const alive = a4.infoOf("warm").alive;
  ok(alive >= 90 && alive <= 105, `预热首帧接近稳态（≈100）: ${alive}`);
}
{
  // world 模拟空间：旧粒子留在原地
  const host = new THREE.Group();
  host.position.set(10, 0, 0);
  const em = createParticleEmitter({ simulationSpace: "world", emissionRate: 100, startLifetime: 10, startSpeed: 0, shape: "box", shapeRadius: 0, gravityModifier: 0, maxParticles: 100 });
  host.add(em.object);
  const a5 = createParticles([{ json: { id: "w" }, obj: host, emitter: em }]);
  a5.update(1 / 60);
  const pa = em.object.geometry.getAttribute("position");
  ok(approx(pa.getX(0), 0, 1e-4), "world 空间：缓冲为本地坐标（出生点本地 ≈ 0）");
  host.position.set(20, 0, 0);
  a5.update(0);
  ok(approx(pa.getX(0), -10, 1e-4), `world 空间：宿主移动后旧粒子留在原地（本地 x=${pa.getX(0).toFixed(3)}）`);
}
{
  // 重力
  const host = new THREE.Group();
  const em = createParticleEmitter({ emissionRate: 100, startLifetime: 10, startSpeed: 0, shape: "box", shapeRadius: 0, gravityModifier: 1, maxParticles: 100 });
  host.add(em.object);
  const a6 = createParticles([{ json: { id: "g" }, obj: host, emitter: em }]);
  a6.update(1 / 60);
  const pa = em.object.geometry.getAttribute("position");
  const y0 = pa.getY(0);
  advance(a6, 1);
  ok(pa.getY(0) < y0 - 3, "gravityModifier=1 → 下落");
}

console.log("[4] 按节点 id 的运行时控制");
{
  const before = api.infoOf("ps1").alive;
  ok(api.pause("ps1") === true && api.infoOf("ps1").paused === true, "pause");
  advance(api, 0.5);
  ok(api.infoOf("ps1").alive === before, "暂停期间粒子冻结");
  ok(api.play("ps1") === true && api.infoOf("ps1").paused === false, "play 续播");
  ok(api.stop("ps1") === true, "stop");
  advance(api, 1.5);
  ok(api.infoOf("ps1").alive === 0, "stop 后粒子自然消亡");
  ok(api.restart("ps1") === true && api.infoOf("ps1").time === 0, "restart 归零");
  advance(api, 0.3);
  ok(api.infoOf("ps1").alive > 0, "restart 后重新发射");
  ok(api.clear("ps1") === true && api.infoOf("ps1").alive === 0, "clear 立即清空");
  ok(api.play("nope") === false && api.pause("nope") === false && api.restart("nope") === false, "未知 id 控制返回 false");

  // updateSettings：非结构参数原地更新（实例复用）
  advance(api, 0.3);
  const aliveBefore = api.infoOf("ps1").alive;
  const objBefore = entry.obj.children.find((c) => c.name === PARTICLES_CHILD_NAME);
  ok(api.updateSettings("ps1", { emissionRate: 5 }) === true, "updateSettings 返回 true");
  ok(api.settingsOf("ps1").emissionRate === 5, "settingsOf 反映新速率");
  ok(entry.obj.children.find((c) => c.name === PARTICLES_CHILD_NAME) === objBefore, "非结构参数 → Points 实例复用");
  ok(api.infoOf("ps1").alive === aliveBefore, "非结构参数 → 存活粒子不重置");
  // 结构参数 → 重建并保留层
  ok(api.updateSettings("ps1", { maxParticles: 55 }) === true, "结构参数 updateSettings");
  const objAfter = entry.obj.children.find((c) => c.name === PARTICLES_CHILD_NAME);
  ok(objAfter !== objBefore && objAfter.geometry.getAttribute("position").count === 55, "结构参数 → Points 重建且容量生效");
  ok(objAfter.layers.mask === 1 << 4, "重建后保留节点层");
  ok(entry.obj.children.filter((c) => c.name === PARTICLES_CHILD_NAME).length === 1, "重建后旧 Points 已摘除");
  ok(api.updateSettings("nope", { emissionRate: 1 }) === false, "未知 id updateSettings → false");
  // 动态新增
  const dyn = new THREE.Group();
  dyn.layers.set(7);
  const em = api.add({ id: "dyn", particles: { emissionRate: 10 } }, dyn);
  ok(!!em && dyn.children.some((c) => c.name === PARTICLES_CHILD_NAME) && em.object.layers.mask === 1 << 7, "add 动态绑定并跟随宿主层");
  ok(api.infoOf("dyn") !== null, "动态绑定可寻址");
}

console.log("[5] 脚本 SDK 接线");
{
  const tve = await import(core("tve.mjs"));
  ok(typeof tve.ParticleSystemNode === "function" && tve.particleSystemNode === tve.ParticleSystemNode, "tve.mjs 导出 ParticleSystemNode + 小写别名");
  ok(Array.isArray(tve.ParticleSystemNode.__nodeKinds) && tve.ParticleSystemNode.__nodeKinds[0] === "particleSystemNode", "__nodeKinds 过滤键");
  ok(new tve.ParticleSystemNode(entry.obj) instanceof tve.Transform, "ParticleSystemNode 派生自 Transform");
  ok(tve.engine && typeof tve.engine.particles?.play === "function" && typeof tve.engine.particles?.setSettings === "function", "engine.particles 门面");
  const proto = tve.ParticleSystemNode.prototype;
  ok(
    ["play", "pause", "stop", "restart", "clear", "setSettings"].every((k) => typeof proto[k] === "function"),
    "实体方法：play/pause/stop/restart/clear/setSettings",
  );
  ok(
    ["emissionRate", "startColor", "maxParticles", "blending", "texture", "playing", "aliveCount", "settings"].every(
      (k) => !!Object.getOwnPropertyDescriptor(proto, k)?.get,
    ),
    "实体属性访问器（发射参数 + texture + 运行态）",
  );
  const scriptsSrc = readFileSync(resolve(root, "public/engine/core/scripts.mjs"), "utf8");
  ok(/particles:\s*particles \?\? null/.test(scriptsSrc), "scripts.mjs 把 particles 注入宿主");
  const nodesSrc = readFileSync(resolve(root, "public/engine/runtime/nodes.mjs"), "utf8");
  ok(/case "particleSystemNode":/.test(nodesSrc), "nodes.mjs 登记 particleSystemNode 分支");
  const playerSrc = readFileSync(resolve(root, "public/web-preview/player.mjs"), "utf8");
  ok(/loadImageTex\(particleTexCache, rel, true\)/.test(playerSrc), "player.mjs 注入粒子贴图加载器（sRGB）");
}

console.log("[6] 贴图异步加载（加载器注入 / 热替换 / 过期丢弃 / 结构重建后重取）");
{
  const sprite = getParticleSpriteTexture();
  const texA = new THREE.Texture();
  const texB = new THREE.Texture();
  const calls = [];
  let resolveSlow = () => {};
  const loader = (rel) => {
    calls.push(rel);
    if (rel === "slow.png") return new Promise((r) => (resolveSlow = r));
    if (rel === "b.png") return Promise.resolve(texB);
    if (rel === "fail.png") return Promise.reject(new Error("nope"));
    return Promise.resolve(null);
  };
  const hostA = new THREE.Group();
  const emA = createParticleEmitter({ texture: "b.png" });
  hostA.add(emA.object);
  const hostN = new THREE.Group();
  const emN = createParticleEmitter({ texture: "" });
  hostN.add(emN.object);
  const api6 = createParticles(
    [
      { json: { id: "t" }, obj: hostA, emitter: emA },
      { json: { id: "none" }, obj: hostN, emitter: emN },
    ],
    loader,
  );
  ok(emA.texture === sprite && emN.texture === sprite, "建出时先采样内置软圆点");
  ok(calls.length === 1 && calls[0] === "b.png", "有贴图引用的绑定触发加载；空串不调用加载器");
  await tick();
  ok(emA.texture === texB && emN.texture === sprite, "加载完成热替换；空贴图保持内置");

  ok(api6.updateSettings("t", { texture: "slow.png" }) === true, "updateSettings 改贴图");
  ok(api6.updateSettings("t", { texture: "b.png" }) === true, "再切回快贴图");
  await tick();
  resolveSlow(texA);
  await tick();
  ok(emA.texture === texB, "过期的慢结果不覆盖新选择");
  api6.updateSettings("t", { texture: "fail.png" });
  await tick();
  ok(emA.texture === sprite, "加载失败回内置软圆点");
  api6.updateSettings("t", { texture: "b.png" });
  await tick();
  api6.updateSettings("t", { texture: "" });
  ok(emA.texture === sprite, "清空贴图立即回内置");

  api6.updateSettings("t", { texture: "b.png" });
  await tick();
  const before = calls.length;
  api6.updateSettings("t", { maxParticles: 21 });
  const rebuilt = hostA.children.find((c) => c.name === PARTICLES_CHILD_NAME).userData.particleEmitter;
  ok(rebuilt !== emA && rebuilt.texture === sprite, "结构重建：新发射器先为内置");
  await tick();
  ok(calls.length === before + 1 && rebuilt.texture === texB, "结构重建后重新取贴图并热替换");

  const dynHost = new THREE.Group();
  const dyn = api6.add({ id: "dyn", particles: { texture: "b.png" } }, dynHost);
  await tick();
  ok(dyn.texture === texB, "add 动态绑定同样加载贴图");

  const noLoader = createParticles([{ json: { id: "x" }, obj: new THREE.Group(), emitter: createParticleEmitter({ texture: "b.png" }) }]);
  await tick();
  ok(noLoader.settingsOf("x").texture === "b.png" && noLoader.infoOf("x") !== null, "无加载器时不报错（保持内置软圆点）");
}

console.log(`\n粒子运行时冒烟：${passed} 通过，${failed} 失败`);
process.exitCode = failed > 0 ? 1 : 0;
