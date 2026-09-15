// ---------------------------------------------------------------------------
// 输入系统「网页运行时」冒烟（Node 直接运行，不经打包）：
// 验证 public/engine/core/tve/input.mjs 的多键/多点触控输入：
//   ① SDK 接线：engine.input === inputApi、keys/pointers 实时视图；
//   ② 多键：任意多键同时按住、keydown 去重（按住重复触发只报一次）、
//      逐键 keyup、keys 集合随按放同步；
//   ③ 单指（鼠标）兼容：坐标 = clientX - 画布 rect（画布局部 CSS 像素）、
//      payload 含 pointerId、up 后 pointers 清空；
//   ④ 多点触控：按 pointerId 分触点（pointers/getPointer）、
//      主指针跟随最后活跃触点、抬一指后 down 仍为 true（存在按下触点）、
//      全部抬起才 down=false；
//   ⑤ 画布外释放：鼠标拖出画布后只在 window 触发 up 也能收到（不卡指）、
//      画布外从未按下的指针不触发 up；
//   ⑥ 双路去重：canvas 与 window 都监听 up/cancel，同一触点只触发一次；
//   ⑦ pointercancel：触发 onPointerCancel 且不再触发 onPointerUp；
//   ⑧ 失焦清空：keys/pointers 全清且不再补发 keyup；
//   ⑨ 悬停移动：未按下也派发 onPointerMove（down=false，不进 pointers）；
//   ⑩ 取消订阅函数生效。
// 运行：npm run smoke:input-runtime
// ---------------------------------------------------------------------------
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

const root = resolve(import.meta.dirname, "..");
const core = (rel) => pathToFileURL(resolve(root, "public/engine/core", rel)).href;

// —— 最小 DOM 垫片：window/document/canvas 事件注册表（手动 fire 驱动）——
const winListeners = new Map();
const canvasListeners = new Map();
const addToListeners = (map, type, fn) => {
  if (!map.has(type)) map.set(type, new Set());
  map.get(type).add(fn);
};
globalThis.window ??= globalThis;
globalThis.addEventListener ??= (type, fn) => addToListeners(winListeners, type, fn);
globalThis.document ??= { createElement: () => ({ style: {}, getContext: () => null }) };
globalThis.self ??= globalThis;

/** 画布 rect 固定 left=10/top=20：clientX/Y - 10/20 = 画布局部坐标 */
const canvas = {
  getBoundingClientRect: () => ({ left: 10, top: 20, width: 800, height: 600 }),
  addEventListener: (type, fn) => addToListeners(canvasListeners, type, fn),
};

const fire = (target, type, init) => {
  const e = { pointerId: 1, clientX: 0, clientY: 0, code: "", ...init };
  const map = target === "canvas" ? canvasListeners : winListeners;
  for (const fn of [...(map.get(type) ?? [])]) fn(e);
};

// —— 加载被测模块（input/state/tve 同 URL 实例，状态共享）——
const { state } = await import(core("tve/state.mjs"));
const inputMod = await import(core("tve/input.mjs"));
const tv = await import(core("tve.mjs"));
state.host = { canvas };
inputMod.installInputListeners();

const input = tv.engine.input;
const handlersOf = (target, type) => [...((target === "canvas" ? canvasListeners : winListeners).get(type) ?? [])];

console.log("[1] SDK 接线");
{
  ok(input === inputMod.inputApi, "engine.input === inputApi（同一对象）");
  ok(input.keys instanceof Set && input.pointers instanceof Map, "keys 为 Set / pointers 为 Map");
  ok(handlersOf("window", "keydown").length === 1 && handlersOf("canvas", "pointerdown").length === 1, "监听只安装一次");
  ok(handlersOf("window", "pointerup").length === 1 && handlersOf("canvas", "pointerup").length === 1, "up 双路监听（canvas + window）");
  ok(handlersOf("canvas", "pointercancel").length === 1 && handlersOf("window", "pointercancel").length === 1, "cancel 双路监听");
}

console.log("[2] 多键按下");
{
  const downs = [];
  const ups = [];
  const offDown = input.onKeyDown((k) => downs.push(k));
  const offUp = input.onKeyUp((k) => ups.push(k));
  fire("window", "keydown", { code: "KeyW" });
  fire("window", "keydown", { code: "KeyA" });
  fire("window", "keydown", { code: "ShiftLeft" });
  ok(input.keys.size === 3 && input.isKeyDown("KeyW") && input.isKeyDown("ShiftLeft"), "三键同时按住");
  ok(downs.join(",") === "KeyW,KeyA,ShiftLeft", `每键各触发一次 onKeyDown: [${downs}]`);
  fire("window", "keydown", { code: "KeyW" });
  ok(downs.length === 3 && input.keys.size === 3, "按住重复 keydown（系统重复）不再触发");
  fire("window", "keyup", { code: "KeyW" });
  ok(ups.join(",") === "KeyW" && !input.isKeyDown("KeyW") && input.keys.size === 2, "逐键 keyup 精确移除");
  fire("window", "keyup", { code: "KeyW" });
  ok(ups.length === 1, "重复 keyup 不再触发");
  fire("window", "keyup", { code: "KeyA" });
  fire("window", "keyup", { code: "ShiftLeft" });
  ok(input.keys.size === 0, "全部抬起后 keys 清空");
  offDown();
  offUp();
  fire("window", "keydown", { code: "KeyQ" });
  fire("window", "keyup", { code: "KeyQ" });
  ok(downs.length === 3 && ups.length === 3, "取消订阅后不再收到按键事件（此前 KeyA/Shift 抬起已计入）");
}

console.log("[3] 单指（鼠标）与坐标换算");
{
  const downs = [];
  const ups = [];
  const offDown = input.onPointerDown((p) => downs.push(p));
  const offUp = input.onPointerUp((p) => ups.push(p));
  fire("canvas", "pointerdown", { pointerId: 7, clientX: 110, clientY: 120 });
  ok(downs.length === 1, "pointerdown 触发");
  ok(downs[0].x === 100 && downs[0].y === 100, `坐标 = client - rect（110-10, 120-20）: ${downs[0].x},${downs[0].y}`);
  ok(downs[0].pointerId === 7 && downs[0].down === true, "payload 含 pointerId 且 down=true");
  ok(input.pointer.x === 100 && input.pointer.down === true && input.pointer.pointerId === 7, "主指针同步");
  ok(input.pointers.size === 1 && input.getPointer(7)?.x === 100, "pointers/getPointer 可查触点");
  fire("canvas", "pointerup", { pointerId: 7, clientX: 130, clientY: 150 });
  ok(ups.length === 1 && ups[0].x === 120 && ups[0].y === 130, `up 坐标同步（130-10, 150-20）: ${ups[0]?.x},${ups[0]?.y}`);
  ok(ups[0].pointerId === 7 && ups[0].down === false, "up payload down=false（与旧版一致）");
  ok(input.pointers.size === 0 && input.getPointer(7) === null, "抬起后触点移除");
  ok(input.pointer.down === false, "主指针 down 复位");
  offDown();
  offUp();
}

console.log("[4] 多点触控（双指）");
{
  let moveLast = null;
  const upPayloads = [];
  const offMove = input.onPointerMove((p) => (moveLast = { ...p }));
  const offUp = input.onPointerUp((p) => upPayloads.push(p));
  fire("canvas", "pointerdown", { pointerId: 1, clientX: 100, clientY: 100 });
  fire("canvas", "pointerdown", { pointerId: 2, clientX: 300, clientY: 400 });
  ok(input.pointers.size === 2, "两指同时按下");
  ok(input.pointer.pointerId === 2 && input.pointer.x === 290, "主指针跟随最后活跃触点");
  fire("canvas", "pointermove", { pointerId: 2, clientX: 320, clientY: 440 });
  ok(input.getPointer(2).x === 310 && input.getPointer(2).y === 420, "按 id 更新对应触点坐标");
  ok(input.getPointer(1).x === 90, "另一触点坐标不受影响");
  ok(moveLast.pointerId === 2 && moveLast.down === true, "move payload 指明来源触点");
  fire("canvas", "pointerup", { pointerId: 1, clientX: 100, clientY: 100 });
  ok(input.pointers.size === 1 && input.getPointer(1) === null, "抬一指只移除该触点");
  ok(input.pointer.down === true, "仍有按下触点时 down 保持 true");
  fire("canvas", "pointerup", { pointerId: 2, clientX: 320, clientY: 440 });
  ok(input.pointers.size === 0 && input.pointer.down === false, "全部抬起后 down=false");
  ok(upPayloads.map((p) => p.pointerId).join(",") === "1,2", "up payload 按 pointerId 归属各指");
  offMove();
  offUp();
}

console.log("[5] 画布外释放（window 层兜底）");
{
  let ups = 0;
  let upPayload = null;
  const offUp = input.onPointerUp((p) => {
    ups++;
    upPayload = p;
  });
  fire("canvas", "pointerdown", { pointerId: 3, clientX: 400, clientY: 300 });
  fire("window", "pointerup", { pointerId: 3, clientX: -50, clientY: 9999 });
  ok(ups === 1 && upPayload.x === -60 && upPayload.y === 9979, "拖出画布释放：坐标为负/超出也精确（client - rect）");
  ok(input.pointers.size === 0, "画布外释放不卡指");
  fire("window", "pointerup", { pointerId: 9, clientX: 5, clientY: 5 });
  ok(ups === 1, "画布外从未按下的指针不触发 onPointerUp");
  offUp();
}

console.log("[6] canvas/window 双路去重");
{
  let ups = 0;
  const offUp = input.onPointerUp(() => ups++);
  fire("canvas", "pointerdown", { pointerId: 4, clientX: 10, clientY: 10 });
  fire("canvas", "pointerup", { pointerId: 4, clientX: 10, clientY: 10 });
  fire("window", "pointerup", { pointerId: 4, clientX: 10, clientY: 10 });
  ok(ups === 1, "同一触点 canvas + window 只触发一次");
  offUp();
}

console.log("[7] pointercancel（系统抢占）");
{
  let cancels = 0;
  let ups = 0;
  let cancelPayload = null;
  const offCancel = input.onPointerCancel((p) => {
    cancels++;
    cancelPayload = p;
  });
  const offUp = input.onPointerUp(() => ups++);
  fire("canvas", "pointerdown", { pointerId: 5, clientX: 50, clientY: 60 });
  fire("canvas", "pointercancel", { pointerId: 5 });
  ok(cancels === 1 && cancelPayload.pointerId === 5 && cancelPayload.down === false, "onPointerCancel 触发（payload down=false）");
  ok(ups === 0, "cancel 后不再触发 onPointerUp");
  ok(input.pointers.size === 0 && input.pointer.down === false, "cancel 移除触点");
  fire("window", "pointercancel", { pointerId: 5 });
  ok(cancels === 1, "cancel 双路去重");
  offCancel();
  offUp();
}

console.log("[8] 失焦清空");
{
  fire("window", "keydown", { code: "KeyK" });
  fire("canvas", "pointerdown", { pointerId: 6, clientX: 10, clientY: 10 });
  ok(input.keys.size === 1 && input.pointers.size === 1, "失焦前有按键与触点");
  let ups = 0;
  const offUp = input.onKeyUp(() => ups++);
  fire("window", "blur");
  ok(input.keys.size === 0 && input.pointers.size === 0 && input.pointer.down === false, "失焦清空 keys/pointers");
  fire("window", "keyup", { code: "KeyK" });
  ok(ups === 0, "清空后补发 keyup 不触发（无残留状态）");
  offUp();
}

console.log("[9] 悬停移动（未按下）");
{
  let movePayload = null;
  const offMove = input.onPointerMove((p) => (movePayload = p));
  fire("canvas", "pointermove", { pointerId: 8, clientX: 200, clientY: 220 });
  ok(movePayload.pointerId === 8 && movePayload.down === false, "悬停 move 派发且 down=false");
  ok(input.pointers.size === 0 && input.pointer.x === 190 && input.pointer.y === 200, "悬停只更新主指针不进 pointers");
  offMove();
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
