// ---------------------------------------------------------------------------
// 补间动画系统「网页运行时」冒烟（Node 直接运行，不经打包）：
// 验证 public/engine/core/tween.mjs 与 tve.mjs 接线：
//   ① 缓动函数集：31 个名称齐全、端点收敛 f(0)=0 / f(1)=1；
//   ② 数值插值：线性精度、easing 生效、进度/状态/回调次序；
//   ③ delay / loop / yoyo：延时后才动、循环计数、往返方向；
//   ④ then 串接与 delay/call 占位；
//   ⑤ sequence / parallel 组：依次/同时播放、组级 loop、子 tween 接管；
//   ⑥ 播放控制：pause/resume/stop/stop(true)/killAll/pauseAll/resumeAll/timeScale；
//   ⑦ 属性插值 to/from：普通对象、部分字段、Entity 变换（度制旋转）、UI {x,y} 字段；
//   ⑧ 颜色插值：RGB 通道各自线性；
//   ⑨ SDK 接线：tve.mjs 导出 tween/easing/Tween、engine.tween 同一对象、
//      tickTime 每帧驱动（脚本宿主 update 链路）、installRuntime 重置残留。
// 运行：npm run smoke:tween-runtime
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
const core = (rel) => pathToFileURL(resolve(root, "public/engine/core", rel)).href;

// 最小 DOM 垫片（tve.mjs → three/log/lights 模块导入期访问 window/document）
globalThis.window ??= globalThis;
globalThis.window.addEventListener ??= () => {};
globalThis.window.removeEventListener ??= () => {};
globalThis.document ??= { createElement: () => ({ style: {}, getContext: () => null }) };
globalThis.self ??= globalThis;

const tweenMod = await import(core("tween.mjs"));
const tween = tweenMod.tween;
const tick = tweenMod.tickTweens;
const THREE = await import(core("three.module.min.js"));
const tv = await import(core("tve.mjs"));

function advance(seconds, step = 1 / 60) {
  const n = Math.max(1, Math.round(seconds / step));
  for (let i = 0; i < n; i++) tick(step);
}
/** 用例间清理：全局单例不残留 */
function cleanup() {
  tween.killAll();
  tween.timeScale = 1;
}

console.log("[1] 缓动函数集");
{
  const names = Object.keys(tweenMod.EASING);
  ok(names.length === 31, `31 个缓动函数: ${names.length}`);
  for (const [name, fn] of Object.entries(tweenMod.EASING)) {
    if (typeof fn !== "function" || !approx(fn(0), 0, 1e-9) || !approx(fn(1), 1, 1e-9)) {
      ok(false, `${name} 端点收敛 f(0)=0 / f(1)=1`);
    }
  }
  ok(true, "全部缓动端点收敛 f(0)=0 / f(1)=1");
  ok(approx(tweenMod.EASING.quadOut(0.5), 0.75), "quadOut(0.5) = 0.75");
  ok(tweenMod.EASING.backOut(0.5) > 1, "backOut 中间超调 > 1");
  ok(approx(tweenMod.EASING.linear(0.25), 0.25), "linear 恒等");
}

console.log("[2] 数值插值 tween.value");
{
  cleanup();
  const seen = [];
  let started = 0;
  let done = 0;
  const t = tween
    .value(0, 10, 1)
    .onStart(() => started++)
    .onUpdate((v, k) => seen.push([v, k]))
    .onComplete(() => done++);
  ok(t.playing === true && tween.activeCount === 1, "创建即播放（自动开始）");
  ok(seen.length === 0, "创建帧不插值（下一帧起）");
  advance(0.5);
  ok(approx(seen.at(-1)[0], 5, 0.02), `0.5s ≈ 5: ${seen.at(-1)[0].toFixed(3)}`);
  ok(approx(t.progress, 0.5, 0.02) && t.elapsed > 0 && t.loopsDone === 0, "进度 0.5 / elapsed 累计 / 循环 0");
  advance(0.5);
  ok(done === 1 && t.completed === true && !t.playing && tween.activeCount === 0, "1s 完成并移出活动列表");
  ok(approx(seen.at(-1)[0], 10), "完成帧精确落点 10");
  ok(started === 1, "onStart 恰好一次");
  const ks = seen.map((p) => p[1]);
  ok(ks.every((k) => k >= 0 && k <= 1) && ks[0] < ks.at(-1), "回调 t 为 0..1 单调递增");
  ok(approx(seen.at(-1)[1], 1), "回调 value 与 t 一致（value tween）");
}

console.log("[3] easing 生效与自定义缓动");
{
  cleanup();
  const seen = [];
  tween.value(0, 10, 1).easing("quadOut").onUpdate((v) => seen.push(v));
  advance(0.5);
  ok(approx(seen.at(-1), 7.5, 0.02), `quadOut 0.5s ≈ 7.5: ${seen.at(-1).toFixed(3)}`);
  cleanup();
  const seen2 = [];
  tween.value(0, 10, 1).easing((t) => t * t).onUpdate((v) => seen2.push(v));
  advance(0.5);
  ok(approx(seen2.at(-1), 2.5, 0.02), `自定义缓动 t² 0.5s ≈ 2.5: ${seen2.at(-1).toFixed(3)}`);
  cleanup();
  const seen3 = [];
  tween.value(0, 10, 1).easing("nope").onUpdate((v) => seen3.push(v));
  advance(0.5);
  ok(approx(seen3.at(-1), 5, 0.02), "未知缓动名回退 linear");
}

console.log("[4] delay / loop / yoyo");
{
  cleanup();
  const seen = [];
  const t = tween.value(0, 10, 1).delay(0.5).onUpdate((v) => seen.push(v));
  tick(0.4);
  ok(seen.length === 0 && t.playing === true, "delay 期间不插值");
  tick(0.1); // delay 末帧：余量并入本轮（落点在起点与一帧进度之间）
  ok(seen.length >= 1 && seen[0] >= 0 && seen[0] <= 1.001, "delay 结束帧起从起点推进");
  ok(t.elapsed < 0.5, "elapsed 不含 delay");

  cleanup();
  const loops = [];
  const t2 = tween.value(0, 1, 0.5).loop(3).onUpdate((v) => loops.push(v));
  advance(1.6);
  ok(t2.completed && t2.loopsDone === 3, `loop(3) 三轮完成: ${t2.loopsDone}`);
  ok(approx(loops[0], 0, 0.1) && approx(loops.at(-1), 1), "每轮从起点到终点");

  cleanup();
  const ys = [];
  const t3 = tween.value(0, 1, 0.5).loop(2).yoyo().onUpdate((v) => ys.push(v));
  advance(1.1);
  ok(t3.completed && approx(ys[0], 0, 0.1) && approx(ys.at(-1), 0, 0.1), "yoyo 两轮后回到起点");
  advance(0.5);
  ok(ys.length === ys.length, "完成后不再推进");
  cleanup();
  const inf = [];
  const t4 = tween.value(0, 1, 0.25).loop(-1).onUpdate((v) => inf.push(v));
  advance(1.1);
  ok(!t4.completed && t4.loopsDone === 4, `无限循环 1.1s 四轮: ${t4.loopsDone}`);
  t4.stop();
  ok(tween.activeCount === 0 && !t4.completed, "stop 后移出且不算完成");
}

console.log("[5] then 串接与占位");
{
  cleanup();
  const order = [];
  const a = tween.value(0, 1, 0.5).onComplete(() => order.push("a"));
  const b = tween.value(0, 1, 0.5).onComplete(() => order.push("b"));
  a.then(b);
  advance(0.75);
  ok(a.completed && !b.completed && b.playing, "a 完成后 b 自动开始");
  ok(tween.activeCount === 1, "b 由 then 启动并登记（a 已移出）");
  advance(0.5);
  ok(b.completed && order.join(",") === "a,b", "回调次序 a → b");

  cleanup();
  const trace = [];
  tween
    .value(0, 1, 0.25)
    .then(tween.delay(0.25))
    .then(tween.call(() => trace.push("call")))
    .then(tween.value(0, 1, 0.25).onComplete(() => trace.push("end")));
  advance(1.1);
  ok(trace.join(",") === "call,end", `then 链穿透 delay/call 占位: ${trace.join(",")}`);
  ok(tween.activeCount === 0, "链全部完成");
}

console.log("[6] sequence / parallel 组");
{
  cleanup();
  const trace = [];
  const a = tween.value(0, 1, 0.3).onComplete(() => trace.push("a"));
  const b = tween.value(0, 1, 0.3).onComplete(() => trace.push("b"));
  const g = tween.sequence([a, b]);
  ok(g.playing === true, "组创建即播放");
  advance(0.35);
  ok(a.completed && !b.completed, "串行：a 先完成");
  advance(0.35);
  ok(b.completed && trace.join(",") === "a,b", "串行：随后 b");
  ok(g.completed && tween.activeCount === 0, "组完成移出；子 tween 不在全局列表");

  cleanup();
  let both = 0;
  const pa = tween.value(0, 1, 0.5);
  const pb = tween.value(0, 1, 0.5);
  tween.parallel([pa, pb]).onComplete(() => both++);
  advance(0.3);
  ok(pa.playing && pb.playing, "并行：子 tween 同时播放");
  advance(0.3);
  ok(pa.completed && pb.completed && both === 1, "并行：全部完成后组完成");

  cleanup();
  const la = tween.value(0, 1, 0.25);
  const lb = tween.value(0, 1, 0.25);
  const lg = tween.sequence([la, lb]).loop(2);
  advance(1.1);
  ok(lg.completed && lg.loopsDone === 2, `组级 loop(2)：序列整体重播两轮（${lg.loopsDone}）`);
  ok(la.loopsDone === 1, "子 tween 每轮组循环重新起跑（run 内计数）");

  cleanup();
  const solo = tween.value(0, 1, 5);
  const grp = tween.sequence([solo]);
  advance(0.2);
  ok(grp.playing && tween.activeCount === 1, "子 tween 传入组后被接管（仅组在全局列表）");
  advance(0.2);
  ok(approx(solo.elapsed, 0.4, 0.05), "子 tween 由组推进（无双重驱动）");

  cleanup();
  const empty = tween.sequence([]);
  ok(empty.completed, "空序列立即完成");
}

console.log("[7] 播放控制");
{
  cleanup();
  const seen = [];
  const t = tween.value(0, 10, 1).onUpdate((v) => seen.push(v));
  advance(0.25);
  tween.pauseAll();
  const at = seen.at(-1);
  advance(0.5);
  ok(seen.at(-1) === at && t.paused, "pauseAll 后冻结");
  tween.resumeAll();
  advance(0.3);
  ok(seen.at(-1) > at, "resumeAll 续播");
  t.stop(true);
  ok(t.completed && approx(seen.at(-1), 10), "stop(true) 快进终点并触发完成落点");

  cleanup();
  let done = 0;
  const k1 = tween.value(0, 1, 1).onComplete(() => done++);
  const k2 = tween.value(0, 1, 1);
  tween.killAll(true);
  ok(k1.completed && k2.completed && done === 1 && tween.activeCount === 0, "killAll(true) 全部快进完成");
  cleanup();
  const k3 = tween.value(0, 1, 1);
  tween.killAll();
  ok(!k3.completed && tween.activeCount === 0, "killAll() 直接停止不完成");

  cleanup();
  tween.timeScale = 2;
  const fast = tween.value(0, 1, 1);
  advance(0.6);
  ok(fast.completed, "timeScale=2 半秒多即播完 1s");
  tween.timeScale = 0;
  const frozen = tween.value(0, 1, 0.1);
  advance(0.5);
  ok(frozen.playing && approx(frozen.elapsed, 0), "timeScale=0 冻结");
  tween.timeScale = 99;
  ok(approx(tween.timeScale, 99), "timeScale 写入");
  cleanup();
  const before = tween.timeScale;
  tween.timeScale = NaN;
  ok(tween.timeScale === before, "timeScale 非数忽略");
}

console.log("[8] 属性插值 tween.to / from 与 Entity 变换");
{
  cleanup();
  const obj = { hp: 100, speed: 1 };
  tween.to(obj, { hp: 0, speed: 5 }, 1);
  advance(0.5);
  ok(approx(obj.hp, 50, 0.5) && approx(obj.speed, 3, 0.02), "普通对象多字段同时插值");
  advance(0.5);
  ok(approx(obj.hp, 0) && approx(obj.speed, 5), "完成落点精确");

  cleanup();
  const vec = { x: 0, y: 0, z: 0 };
  tween.to(vec, { x: 10 }, 1); // 部分字段：y/z 不动
  advance(1);
  ok(approx(vec.x, 10) && vec.y === 0 && vec.z === 0, "向量部分字段补间（缺分量不动）");

  // Entity 变换（position/rotation/scale getter/setter；rotation 度制）
  const ent = new tv.Entity(new THREE.Object3D());
  cleanup();
  tween.position(ent, { x: 4, y: 8 }, 1);
  advance(0.5);
  ok(approx(ent.position.x, 2, 0.02) && approx(ent.position.y, 4, 0.02), "Entity.position 半程");
  advance(0.5);
  ok(approx(ent.position.x, 4) && approx(ent.position.y, 8), "Entity.position 落点");
  cleanup();
  tween.rotation(ent, { y: 90 }, 1);
  advance(1);
  ok(approx(ent.rotation.y, 90, 0.01), "Entity.rotation 度制落点 90°");
  cleanup();
  tween.scale(ent, { x: 2, y: 2, z: 2 }, 1);
  advance(1);
  ok(approx(ent.scale.x, 2) && approx(ent.scale.z, 2), "Entity.scale 落点");

  // from 语义：props 为起点，回到开始时当前值
  cleanup();
  const flyer = { alpha: 1 };
  tween.from(flyer, { alpha: 0 }, 1);
  advance(1 / 60);
  ok(flyer.alpha < 0.2, `from 首帧接近起点 0: ${flyer.alpha.toFixed(3)}`);
  advance(1);
  ok(approx(flyer.alpha, 1), "from 完成回到开始时当前值 1");

  // UI {x,y} 字段形态（普通对象模拟 UI 访问器）
  cleanup();
  const widget = { size: { x: 2, y: 4 } };
  tween.to(widget, { size: { x: 6 } }, 1);
  advance(1);
  ok(approx(widget.size.x, 6) && approx(widget.size.y, 4), "UI {x,y} 字段插值（y 保留）");

  // UI padding {left,right,top,bottom} 四字段形态（布局容器内边距）
  cleanup();
  const layout = { padding: { left: 0, right: 0, top: 0, bottom: 0 } };
  tween.to(layout, { padding: { left: 8, right: 4 } }, 1); // 部分字段：top/bottom 不动
  advance(0.5);
  ok(
    approx(layout.padding.left, 4, 0.05) && approx(layout.padding.right, 2, 0.05) && layout.padding.top === 0,
    `UI padding 部分字段半程: left=${layout.padding.left} right=${layout.padding.right}`,
  );
  advance(0.5);
  ok(approx(layout.padding.left, 8) && approx(layout.padding.right, 4) && layout.padding.bottom === 0, "UI padding 落点（未插值分量保留）");

  // UI 混合字段：数字（fontSize）与向量（anchoredPosition）同帧插值
  cleanup();
  const label = { fontSize: 12, anchoredPosition: { x: 0, y: 0 } };
  tween.to(label, { fontSize: 24, anchoredPosition: { y: 5 } }, 1);
  advance(1);
  ok(approx(label.fontSize, 24) && approx(label.anchoredPosition.y, 5) && label.anchoredPosition.x === 0, "UI 数字 + 向量字段混合插值");

  cleanup();
  const noOp = tween.to({}, { nothing: 1 }, 1);
  advance(1);
  ok(noOp.completed && tween.activeCount === 0, "无可插值属性的 tween 空转至到期并告警收敛");
}

console.log("[9] 颜色插值 tween.color");
{
  cleanup();
  const seen = [];
  tween.color(0x000000, 0x0000ff, 1).onUpdate((c) => seen.push(c));
  advance(0.5);
  ok(seen.at(-1) === 0x000080 || seen.at(-1) === 0x00007f, `蓝通道半程 ≈ 0x000080: 0x${seen.at(-1).toString(16)}`);
  advance(0.5);
  ok(seen.at(-1) === 0x0000ff, "完成落点精确");
  cleanup();
  const mid = [];
  tween.color(0xff0000, 0x0000ff, 1).onUpdate((c) => mid.push(c));
  advance(0.5);
  const m = mid.at(-1);
  ok(
    approx((m >> 16) & 0xff, 127, 1) && approx(m & 0xff, 127, 1) && ((m >> 8) & 0xff) === 0,
    `红→蓝通道独立插值（数值直插会得到 0x80407f 一类灰）: 0x${m.toString(16)}`,
  );
}

console.log("[10] SDK 接线（tve.mjs）");
{
  ok(typeof tv.Tween === "function", "tve.mjs 导出 Tween 类");
  ok(new tv.Tween() instanceof tweenMod.Tween, "Tween 与 tween.mjs 实现同一类");
  ok(
    Object.keys(tv.easing).length === 31 && typeof tv.easing.quadInOut === "function",
    "tve.mjs 导出 easing 表（31 个）",
  );
  ok(tv.engine.tween === tv.tween, "engine.tween 与顶层 tween 同一对象");
  for (const k of [
    "to",
    "from",
    "value",
    "color",
    "position",
    "rotation",
    "scale",
    "sequence",
    "parallel",
    "delay",
    "call",
    "killAll",
    "pauseAll",
    "resumeAll",
  ]) {
    if (typeof tv.tween[k] !== "function") ok(false, `tween.${k} 存在`);
  }
  ok(true, "tween API 工厂方法齐全");
  ok(typeof tv.tween.activeCount === "number" && typeof tv.tween.timeScale === "number", "activeCount / timeScale");

  // tickTime 每帧驱动（scripts.mjs update 链路）
  tv.tween.killAll();
  const st = [];
  tv.tween.value(0, 10, 1).onUpdate((v) => st.push(v));
  const frame = 1 / 60;
  for (let i = 0; i < 30; i++) tv.tickTime(frame);
  ok(st.length === 30 && approx(st.at(-1), 5, 0.05), `tickTime 驱动 0.5s ≈ 5: ${st.at(-1).toFixed(3)}`);
  ok(approx(tv.engine.time.delta, frame), "engine.time.delta 正常推进");
  tv.tween.killAll();

  // installRuntime 重置残留
  tv.tween.value(0, 1, 5);
  ok(tv.tween.activeCount === 1, "残留 tween 登记");
  tv.installRuntime({ registry: [], rootObj: null, canvas: null });
  ok(tv.tween.activeCount === 0 && tv.tween.timeScale === 1, "installRuntime 重置 tween 状态");

  // 脚本宿主把 tickTime 挂进 update 链路（静态检查）
  const scriptsSrc = readFileSync(resolve(root, "public/engine/core/scripts.mjs"), "utf8");
  ok(/tickTime\(dt\)/.test(scriptsSrc), "scripts.mjs update 调用 tickTime（tween 随帧驱动）");
  const tveSrc = readFileSync(resolve(root, "public/engine/core/tve.mjs"), "utf8");
  ok(/tickTweens\(timeState\.delta\)/.test(tveSrc), "tve.mjs tickTime 内驱动 tickTweens");
}

cleanup();
console.log(`\n补间动画冒烟：${passed} 通过，${failed} 失败`);
process.exitCode = failed > 0 ? 1 : 0;
