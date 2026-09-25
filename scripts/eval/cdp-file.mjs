// 从文件读取 JS 表达式在 CDP target 里执行（长脚本用）。
// 用法：node scripts/eval/cdp-file.mjs <file.js> [--target <子串>] [--json]
import { readFileSync } from "node:fs";

const PORT = process.env.CDP_PORT || 9223;
const [file, ...rest] = process.argv.slice(2);
const targetFlagIdx = rest.indexOf("--target");
const target = targetFlagIdx >= 0 ? rest[targetFlagIdx + 1] : null;
const expression = readFileSync(file, "utf8");

const res = await fetch(`http://127.0.0.1:${PORT}/json`);
const targets = (await res.json()).filter(
  (t) => (t.type === "page" || t.type === "iframe") && (!target || t.title.includes(target) || t.url.includes(target)),
);
if (!targets.length) throw new Error("找不到 target: " + target);
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((res2, rej2) => {
  ws.onopen = res2;
  ws.onerror = rej2;
});
const reply = new Promise((res2, rej2) => {
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id === 1) msg.error ? rej2(new Error(msg.error.message)) : res2(msg.result);
  };
});
ws.send(
  JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: { expression, returnByValue: true, awaitPromise: true, userGesture: true },
  }),
);
const r = await reply;
ws.close();
if (r.exceptionDetails) {
  console.error("EVAL ERROR:", JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(r.result?.value, null, 2));
