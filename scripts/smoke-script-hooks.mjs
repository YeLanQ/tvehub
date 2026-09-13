// ---------------------------------------------------------------------------
// 脚本生命周期钩子「网页运行时」冒烟（Node 直接运行，不经打包）：
// 验证 public/engine/core/scripts.mjs 的 fixedUpdate/update/lateUpdate 驱动：
//   ① 固定步长：帧间隔累积到 1/60s 才触发 onFixedUpdate（参数 = 固定步长）；
//   ② 帧内时序：onFixedUpdate*（0..n）先于 onUpdate，onLateUpdate 收尾；
//   ③ 小帧间隔不触发（0 次），掉帧补偿上限 4 次（与物理 MAX_SUBSTEPS 一致）；
//   ④ 跨帧累积：连续小帧间隔凑满步长后补触发；
//   ⑤ 错误隔离：onFixedUpdate 抛错只停用该实例，其他实例照常驱动；
//   ⑥ 空场景宿主：noop 形态同样提供 fixedUpdate/lateUpdate 空实现。
// 运行：npm run smoke:script-hooks
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
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
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const root = resolve(import.meta.dirname, "..");
const core = (rel) => pathToFileURL(resolve(root, "public/engine/core", rel)).href;

// 最小 DOM 垫片（tve.mjs → three/log 模块导入期访问 window/document；
// baseURI 供 scripts.mjs 文件模式寻址用户脚本模块）
globalThis.window ??= globalThis;
globalThis.window.addEventListener ??= () => {};
globalThis.window.removeEventListener ??= () => {};
globalThis.self ??= globalThis;
const tmpRoot = resolve(root, ".tmp-smoke/script-hooks");
rmSync(tmpRoot, { recursive: true, force: true });
mkdirSync(resolve(tmpRoot, "src"), { recursive: true });
globalThis.document ??= { createElement: () => ({ style: {}, getContext: () => null }) };
globalThis.document.baseURI = pathToFileURL(tmpRoot + "/").href;

// 用户脚本模块（createScripts 按 src/**.ts 引用加载编译产物 src/**.js）；
// 模块级 calls 数组经同 URL 直接导入共享，供断言读取。
// shim.mjs 以字面量 file URL 再导出 tve.mjs 的 Component（node 无 import map，
// 脚本内不能写裸说明符 "tve"；同 URL 模块实例保证 instanceof 命中）。
const tveUrl = core("tve.mjs");
writeFileSync(
  resolve(tmpRoot, "shim.mjs"),
  `export { Component } from ${JSON.stringify(tveUrl)};\n`,
);
writeFileSync(
  resolve(tmpRoot, "src/hooks-ok.js"),
  `import { Component } from "../shim.mjs";
export const calls = [];
export default class HooksOk extends Component {
  onFixedUpdate(fixedDelta) { calls.push(["fixed", fixedDelta]); }
  onUpdate(delta) { calls.push(["update", delta]); }
  onLateUpdate(delta) { calls.push(["late", delta]); }
}
`,
);
writeFileSync(
  resolve(tmpRoot, "src/hooks-broken.js"),
  `import { Component } from "../shim.mjs";
export const calls = [];
export default class HooksBroken extends Component {
  onFixedUpdate() { calls.push("fixed"); throw new Error("boom"); }
  onUpdate() { calls.push("update"); }
  onLateUpdate() { calls.push("late"); }
}
`,
);

const { createScripts } = await import(core("scripts.mjs"));

const mkNode = (id, script, order) => ({
  json: {
    id,
    components: [{ type: "script", enabled: true, script, executionOrder: order }],
  },
  obj: { name: id, userData: { nodeId: id, nodeKind: "node" } },
});
const nodes = [
  mkNode("n1", "src/hooks-ok.ts", 0),
  mkNode("n2", "src/hooks-broken.ts", 5),
];
const opts = { nodes, cfg: {}, animations: null, audios: null, physics: null, clipAnims: null, particles: null, ui: null, canvas: null };
const host = await createScripts(opts);

const okCalls = (await import(pathToFileURL(resolve(tmpRoot, "src/hooks-ok.js")).href)).calls;
const brokenCalls = (await import(pathToFileURL(resolve(tmpRoot, "src/hooks-broken.js")).href)).calls;

// ① 正常帧（dt = 1/30s）：两次固定步长 + 一次 update/lateUpdate，参数正确
host.fixedUpdate(1 / 30);
host.update(1 / 30);
host.lateUpdate(1 / 30);
ok(okCalls.length === 4, `一帧产生 2 次 fixed + 1 次 update + 1 次 late（实际 ${okCalls.length}）`);
ok(okCalls.filter((c) => c[0] === "fixed").every((c) => approx(c[1], 1 / 60)), "onFixedUpdate 参数 = 固定步长 1/60");
ok(okCalls.find((c) => c[0] === "update")?.[1] === 1 / 30 && okCalls.find((c) => c[0] === "late")?.[1] === 1 / 30, "onUpdate/onLateUpdate 参数 = 帧间隔");

// ② 帧内时序：fixed* → update → late
const kinds = okCalls.map((c) => c[0]).join(",");
ok(kinds === "fixed,fixed,update,late", `帧内时序 fixed×2 → update → late（实际 ${kinds}）`);

// ③ 小帧间隔（< 1/60s）不触发固定步长
const before = okCalls.length;
host.fixedUpdate(0.005);
ok(okCalls.length === before, "小于固定步长的帧间隔不触发 onFixedUpdate");

// ④ 跨帧累积：12 帧 × 5ms = 60ms，凑满 3 个步长（余量滚入下帧）
for (let i = 0; i < 12; i++) host.fixedUpdate(0.005);
ok(okCalls.length - before === 3, `连续小帧累积后补触发 3 次（实际 ${okCalls.length - before}）`);

// ⑤ 掉帧补偿上限：1s 帧间隔最多补 4 次（FIXED_DT × MAX_SUBSTEPS）
const beforeClamp = okCalls.length;
host.fixedUpdate(1);
ok(okCalls.length - beforeClamp === 4, `超大帧间隔补偿上限 4 次（实际 ${okCalls.length - beforeClamp}）`);

// ⑥ 错误隔离：onFixedUpdate 抛错 → 该实例永久停用，其他实例不受影响
ok(brokenCalls.length === 1 && brokenCalls[0] === "fixed", "抛错实例只执行了首次 onFixedUpdate 即停用");
ok(okCalls.every((c) => c[0] !== undefined), "正常实例全程未被波及");
const beforeIso = okCalls.length;
host.fixedUpdate(1 / 30);
host.update(1 / 30);
host.lateUpdate(1 / 30);
ok(okCalls.length - beforeIso === 4, "后续帧正常实例继续驱动（2 fixed + 1 update + 1 late）");

// ⑦ 停机幂等
host.dispose();
host.dispose();
ok(true, "dispose 重复调用安全");

// ⑧ getComponent(类名) 查找脚本组件（state.resolveScriptInstance 槽位接线回归：
//    漏接线会让按类名/源路径查找脚本组件永远返回 null）
const tv = await import(core("tve.mjs"));
const entOk = tv.getEntity(nodes[0].obj);
const entBroken = tv.getEntity(nodes[1].obj);
ok(entOk?.getComponent("HooksOk") != null, "getComponent(类名) 命中已挂载脚本组件");
ok(entBroken?.getComponent("HooksBroken") != null, "getComponent(类名) 对另一实例同样命中");
ok(entOk?.getComponent("HooksBroken") == null, "getComponent(类名) 不串其他实例");

// ⑨ 空场景宿主：noop 形态含全部驱动入口
const empty = await createScripts({ ...opts, nodes: [] });
ok(
  typeof empty.fixedUpdate === "function" && typeof empty.update === "function" &&
    typeof empty.lateUpdate === "function" && typeof empty.dispose === "function",
  "无脚本时宿主为 noop 形态（含 fixedUpdate/lateUpdate）",
);
empty.fixedUpdate(1 / 30);
empty.update(1 / 30);
empty.lateUpdate(1 / 30);

rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "全部通过" : "存在失败"}：${passed} 项通过，${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
