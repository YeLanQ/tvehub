// CDP（Chrome DevTools Protocol）最小客户端：连 WebView2 远程调试端口，
// 在指定 target 的页面上下文里执行 JS 表达式。用于引擎性能评测（测帧率/暂停）。
// 用法：node scripts/eval/cdp.mjs eval "<js>" [--target <title或url子串>] [--await]
//       node scripts/eval/cdp.mjs list
const PORT = process.env.CDP_PORT || 9223;

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  if (!res.ok) throw new Error(`CDP /json ${res.status}`);
  return res.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          return new Promise((res2, rej2) => {
            const mid = ++id;
            pending.set(mid, { res: res2, rej: rej2 });
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        },
        close() {
          ws.close();
        },
      });
    ws.onerror = (e) => reject(new Error("WS error: " + (e?.message ?? e)));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message));
        else p.res(msg.result);
      }
    };
  });
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "list") {
  const targets = await listTargets();
  for (const t of targets) {
    if (t.type === "page") console.log(`${t.title} | ${t.url} | ${t.id}`);
  }
  process.exit(0);
}
if (cmd === "eval") {
  let expr = rest[0];
  const flagIdx = rest.indexOf("--target");
  const targetMatch = flagIdx >= 0 ? rest[flagIdx + 1] : null;
  const awaitPromise = rest.includes("--await");
  if (flagIdx >= 0) expr = rest.slice(0, flagIdx).join(" ");
  const targets = (await listTargets()).filter(
    (t) => (t.type === "page" || t.type === "iframe") && (!targetMatch || t.title.includes(targetMatch) || t.url.includes(targetMatch)),
  );
  if (!targets.length) throw new Error(`找不到 target: ${targetMatch ?? "(任意)"}`);
  const c = await connect(targets[0].webSocketDebuggerUrl);
  const r = await c.send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  });
  c.close();
  if (r.exceptionDetails) {
    console.error("EVAL ERROR:", JSON.stringify(r.exceptionDetails, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(r.result?.value ?? r.result, null, 2));
  process.exit(0);
}
console.error("用法: cdp.mjs list | eval <js> [--target <子串>] [--await]");
process.exit(1);
