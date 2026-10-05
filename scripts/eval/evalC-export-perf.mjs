// 评测C：导出产物真实浏览器性能 —— 自组装 web 多文件产物（player+engine+压测场景），
// 用 headless Chromium 打开 http（多文件部署）与 file://（本地双击）两种形态，
// 采集 HUD 指标（后端/Worker/DrawCall/JS堆）+ rAF 帧距分布 + 装配 console 日志。
// 核心对照：http（Worker 可用）vs file://（Worker 回退主线程）的帧距差异。
// 用法：node scripts/eval/evalC-export-perf.mjs [--out reports/export-perf.json] [--keep]
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "../..");
const SITE = join(ROOT, ".tmp", "evalC", "site");
const OUT = (() => {
  const i = process.argv.indexOf("--out");
  return i > 0 ? resolve(process.argv[i + 1]) : join(ROOT, "reports", "export-perf.json");
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 压测场景（scene.json 格式与 buildSceneTree 消费一致；组件字段同 smoke 样例）
// ---------------------------------------------------------------------------
const meshJson = (id, extra = {}) => ({
  type: "meshNode",
  id,
  name: id,
  source: "primitive",
  geometry: "box",
  size: { x: 1, y: 1, z: 1 },
  material: "mat-a.mat",
  ...extra,
});
const matOf = (id, color) => writeFileSync(join(SITE, id), JSON.stringify({ materialType: "physical", color, metalness: 0.1, roughness: 0.75 }));

function staticScene() {
  const children = [
    { type: "ambientLightNode", id: "amb", name: "环境光", transform: {}, ambient: { color: "#404048", intensity: 0.6 } },
    { type: "directionalLightNode", id: "sun", name: "平行光", castShadow: true, transform: { position: { x: 60, y: 90, z: 40 }, rotation: { x: -50, y: 30, z: 0 } } },
    meshJson("ground", { geometry: "box", size: { x: 220, y: 1, z: 220 }, transform: { position: { x: 0, y: -0.5, z: 0 } } }),
    { type: "cameraNode", id: "cam", name: "相机", fov: 60, near: 0.1, far: 1000, transform: { position: { x: 0, y: 70, z: 170 }, rotation: { x: -20, y: 0, z: 0 } } },
  ];
  for (let i = 0; i < 10; i++)
    for (let j = 0; j < 20; j++)
      children.push(meshJson(`b${i}${j}`, { transform: { position: { x: (j - 10) * 8, y: 1, z: (i - 5) * 8 } } }));
  for (let k = 0; k < 50; k++)
    children.push(meshJson(`s${k}`, {
      geometry: "sphere", material: "mat-b.mat", size: { x: 3, y: 3, z: 3 },
      transform: { position: { x: (k % 10) * 9 - 45, y: 8, z: 60 + Math.floor(k / 10) * 9 } },
    }));
  return { root: { type: "node", id: "root", children }, settings: {} };
}

function physicsScene() {
  const children = [
    { type: "ambientLightNode", id: "amb", name: "环境光", transform: {}, ambient: { color: "#404048", intensity: 0.6 } },
    { type: "directionalLightNode", id: "sun", name: "平行光", castShadow: true, transform: { position: { x: 60, y: 90, z: 40 }, rotation: { x: -50, y: 30, z: 0 } } },
    meshJson("ground", { geometry: "box", size: { x: 120, y: 1, z: 120 }, transform: { position: { x: 0, y: -0.5, z: 0 } }, components: [{ type: "collider", enabled: true, collider: { shape: "box", autoSize: true, size: { x: 1, y: 1, z: 1 }, friction: 0.6, restitution: 0.1 } }] }),
    { type: "cameraNode", id: "cam", name: "相机", fov: 60, near: 0.1, far: 1000, transform: { position: { x: 0, y: 45, z: 80 }, rotation: { x: -25, y: 0, z: 0 } } },
  ];
  for (let k = 0; k < 60; k++)
    children.push(meshJson(`d${k}`, {
      geometry: "sphere", material: "mat-b.mat", size: { x: 2, y: 2, z: 2 },
      transform: { position: { x: (k % 10) * 4 - 18, y: 5 + Math.floor(k / 10) * 6, z: Math.floor((k % 30) / 10) * 4 - 4 } },
      components: [
        { type: "rigidBody", enabled: true, rigidBody: { mode: "dynamic", mass: 1 } },
        { type: "collider", enabled: true, collider: { shape: "sphere", autoSize: false, size: { x: 2, y: 2, z: 2 }, friction: 0.6, restitution: 0.2 } },
      ],
    }));
  return {
    root: { type: "node", id: "root", children },
    settings: { physics: { physicsEnabled: true, backend: "rapier", gravity: { x: 0, y: -9.81, z: 0 } } },
  };
}

function assembleSite() {
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(SITE, { recursive: true });
  cpSync(join(ROOT, "public", "web-preview", "player.mjs"), join(SITE, "player.mjs"));
  cpSync(join(ROOT, "public", "engine"), join(SITE, "engine"), { recursive: true });
  const tpl = readFileSync(join(ROOT, "public", "exports", "web", "multi", "index.html"), "utf8");
  writeFileSync(join(SITE, "index.html"), tpl.replace("{{TITLE}}", "evalC 导出产物性能"));
  writeFileSync(join(SITE, "scene.json"), JSON.stringify(staticScene()));
  writeFileSync(join(SITE, "scene-physics.json"), JSON.stringify(physicsScene()));
  writeFileSync(join(SITE, "config.json"), JSON.stringify({
    debug: true,
    mainScene: "压测静态",
    scenes: [
      { name: "压测静态", file: "scene.json" },
      { name: "压测物理", file: "scene-physics.json" },
    ],
  }));
  matOf("mat-a.mat", "#c94f4f");
  matOf("mat-b.mat", "#4f7fc9");
}

// ---------------------------------------------------------------------------
// 单页形态模拟（single page 语义：__TVE_BUILD_DATA 内联数据 → player 走 inline
// 分支 → Worker URL 不解析 → 物理/动画回退主线程）。player+engine 经 esbuild
// 打成自包含 bundle；wasm 保留真实文件（fetch 垫片 miss 透传原生 fetch 命中）。
// ---------------------------------------------------------------------------
const SINGLE = join(ROOT, ".tmp", "evalC", "single");
async function assembleSingleSite() {
  const esbuild = await import("esbuild");
  rmSync(SINGLE, { recursive: true, force: true });
  mkdirSync(SINGLE, { recursive: true });
  cpSync(join(ROOT, "public", "engine", "runtime", "physics-engines"), join(SINGLE, "engine", "runtime", "physics-engines"), { recursive: true });
  await esbuild.build({
    entryPoints: [join(ROOT, "public", "web-preview", "player.mjs")],
    bundle: true, format: "esm", minify: false, external: ["node:*"],
    outdir: SINGLE, entryNames: "player.bundle", chunkNames: "chunks/[name]-[hash]",
    logLevel: "silent",
  });
  const b64 = (s) => Buffer.from(s).toString("base64");
  const data = {
    config: {
      debug: true, mainScene: "压测静态",
      scenes: [{ name: "压测静态", file: "scene.json" }, { name: "压测物理", file: "scene-physics.json" }],
    },
    assets: {
      "scene.json": b64(JSON.stringify(staticScene())),
      "scene-physics.json": b64(JSON.stringify(physicsScene())),
      "mat-a.mat": b64(JSON.stringify({ materialType: "physical", color: "#c94f4f", metalness: 0.1, roughness: 0.75 })),
      "mat-b.mat": b64(JSON.stringify({ materialType: "physical", color: "#4f7fc9", metalness: 0.1, roughness: 0.75 })),
    },
  };
  const tpl = readFileSync(join(ROOT, "public", "exports", "web", "multi", "index.html"), "utf8");
  const html = tpl
    .replace("{{TITLE}}", "evalC 单页形态")
    .replace('<script type="module" src="./player.mjs"></script>',
      '<script>window.__TVE_BUILD_DATA = ' + JSON.stringify(data) + '</script>\n    <script type="module" src="./player.bundle.js"></script>');
  writeFileSync(join(SINGLE, "index.html"), html);
}

// ---------------------------------------------------------------------------
// 本地静态服务（多文件部署形态；Content-Type 对 .mjs/.wasm 必须正确）
// ---------------------------------------------------------------------------
const MIME = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".json": "application/json", ".mat": "application/json", ".wasm": "application/wasm" };
function serveStatic(dir) {
  return new Promise((res) => {
    const srv = createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      const file = join(dir, decodeURIComponent(url.pathname));
      if (!file.startsWith(dir) || !existsSync(file)) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": MIME[file.slice(file.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    });
    srv.listen(0, "127.0.0.1", () => res(srv));
  });
}

// ---------------------------------------------------------------------------
// headless Chromium（优先 Chrome，回退 Edge；真实 GPU 管线 --enable-gpu）
// ---------------------------------------------------------------------------
async function launchBrowser() {
  const candidates = [
    process.env.TVE_EVAL_BROWSER,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  const exe = candidates.find((p) => existsSync(p));
  if (!exe) throw new Error("未找到 Chrome/Edge，可设 TVE_EVAL_BROWSER 指定路径");
  const profile = join(tmpdir(), "tve-evalC-profile");
  rmSync(profile, { recursive: true, force: true });
  const args = (gpuFlags) => [
    "--headless=new", `--remote-debugging-port=0`, `--user-data-dir=${profile}`,
    "--no-first-run", "--disable-extensions", "--window-size=1280,720",
    ...gpuFlags, "about:blank",
  ];
  for (const gpuFlags of [["--enable-gpu", "--use-angle=default"], []]) {
    const child = spawn(exe, args(gpuFlags), { stdio: "ignore" });
    const portFile = join(profile, "DevToolsActivePort");
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      if (existsSync(portFile)) {
        const port = Number((await readFile(portFile, "utf8")).split("\n")[0]);
        if (port > 0) return { child, port, gpu: gpuFlags.length > 0, exe };
      }
      if (child.exitCode !== null) break;
    }
    try { child.kill(); } catch { /* ignore */ }
  }
  throw new Error("Chromium 启动失败（DevToolsActivePort 未出现）");
}

// ---------------------------------------------------------------------------
// CDP 最小客户端（全局 WebSocket，Node ≥21）
// ---------------------------------------------------------------------------
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res2, rej2) => {
          const mid = ++id;
          pending.set(mid, { res: res2, rej: rej2 });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      set onmessage(fn) { ws._handler = fn; },
      close() { ws.close(); },
    });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message));
        else p.res(msg.result);
      } else if (ws._handler) ws._handler(msg);
    };
    ws.onerror = (e) => reject(new Error("WS error: " + (e?.message ?? e)));
  });
}

async function withPage(port, url, run) {
  const created = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json());
  const cdp = await connect(created.webSocketDebuggerUrl);
  const logs = [];
  cdp.onmessage = (msg) => {
    if (msg.method === "Runtime.consoleAPICalled") {
      logs.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    } else if (msg.method === "Runtime.exceptionThrown") {
      logs.push("[exception] " + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
    }
  };
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url });
  await sleep(4000); // 装配 + wasm/着色器预热
  const out = await run({
    eval: async (expr, awaitPromise = false) => {
      const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluate failed");
      return r.result?.value;
    },
  });
  cdp.close();
  await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`).catch(() => {});
  return { logs, ...out };
}

// HUD 读取（帧循环真实帧距由 player 侧统计：阶段一新增的 p50/p95/max 行）
const HUD_READ = `(() => { const g = (s) => document.querySelector(s)?.textContent ?? null;
  return { fps: g("#dbg-fps"), frame: g("#dbg-frame"), calls: g("#dbg-calls"), backend: g("#dbg-backend"), worker: g("#dbg-worker"), heap: g("#dbg-heap"),
    error: (document.getElementById("error")?.textContent || "").trim() || null, hasCanvas: !!document.querySelector("canvas") }; })()`;

async function sampleTarget(port, url, label) {
  console.log(`  [${label}] ${url.slice(0, 60)}`);
  return withPage(port, url, async ({ eval: ev }) => {
    // 打开 F3 调试面板，等两次刷新（200ms 间隔）再读
    await ev(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "F3" }))`);
    await sleep(800);
    const hud = await ev(HUD_READ);
    return { hud };
  }).then((r) => ({ label, url, ...r }));
}

// ---------------------------------------------------------------------------
// 主流程：组装 → 起服务 → 起浏览器 → 四格矩阵采集 → 台账落盘
// ---------------------------------------------------------------------------
async function main() {
  assembleSite();
  await assembleSingleSite();
  const srv = await serveStatic(SITE);
  const srv2 = await serveStatic(SINGLE);
  const httpPort = srv.address().port;
  const httpPort2 = srv2.address().port;
  const { child, port, gpu, exe } = await launchBrowser();
  console.log(`浏览器: ${exe}${gpu ? "（GPU 管线）" : "（软件渲染）"}  CDP:${port}  HTTP:${httpPort}/${httpPort2}`);
  const results = [];
  try {
    results.push(await sampleTarget(port, `http://127.0.0.1:${httpPort}/index.html`, "multi-静态"));
    results.push(await sampleTarget(port, `http://127.0.0.1:${httpPort}/index.html?scene=压测物理`, "multi-物理"));
    results.push(await sampleTarget(port, `http://127.0.0.1:${httpPort2}/index.html`, "single-静态"));
    results.push(await sampleTarget(port, `http://127.0.0.1:${httpPort2}/index.html?scene=压测物理`, "single-物理"));
    results.push(await sampleTarget(port, pathToFileURL(join(SITE, "index.html")).href, "file-多文件(CORS)"));
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    srv.close();
    srv2.close();
  }
  const report = {
    stamp: new Date().toISOString(),
    browser: exe,
    gpuPipeline: gpu,
    site: SITE,
    targets: results,
  };
  mkdirSync(join(OUT, ".."), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\n台账 → ${OUT}\n`);
  for (const r of results) {
    console.log(`[${r.label}] HUD: FPS=${r.hud.fps} 帧距=${r.hud.frame} DrawCalls=${r.hud.calls} 后端=${r.hud.backend} ${r.hud.worker} 堆=${r.hud.heap ?? "N/A"} canvas=${r.hud.hasCanvas}`);
    if (r.hud.error) console.log(`         ✗ 错误层: ${r.hud.error.slice(0, 300)}`);
    const warns = r.logs.filter((l) => l.includes("[TvE]") || l.includes("[动画]") || l.includes("Worker"));
    for (const w of warns) console.log(`         ⚠ ${w}`);
  }
  if (!process.argv.includes("--keep")) rmSync(join(ROOT, ".tmp", "evalC"), { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
