// 桥接层契约一致性测试（node 自包含，构建链内运行；exit code 判定）。
// 固化本渠道迭代中踩出的关键语义，回归即红：
// - assertHost：端点缺方法注册即抛错
// - host 缺席：核心安装整体空转（node 环境无副作用）
// - 首个 canvas 归渲染器：createElement(NS)("canvas") 首调返回屏上画布，后续走离屏链
// - 图片：同对象增强（src 访问器平台）+ 内联表桥接（data URL）；退化包装器（src 不可重定义）
// - createImageBitmap：解析出原生平台 image（纹理源身份）
// - 音频：getter-only resume 平台形态下 Proxy 门面不抛错、resume 返回 Promise、state 转 running
// - fetch：内联资产表命中（含相对路径归一化）
// - 事件：平台触摸 → canvas 与 window 双监听面派发
// - 全局覆盖：GLOBAL_SURFACE 清单安装后全部存在

import fs from "node:fs";
import vm from "node:vm";

const ROOT = process.argv[2] || process.cwd();
let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------- 场景 A：host 缺席
// 核心模块在无 host 时导入必须整体空转（不写任何全局）。
// 注意：ESM 模块一进程只求值一次——本场景用 query 串缓存击穿独立求值，
// 避免污染场景 B 的「host 已注册」全流程。
{
  const { bridgeActive } = await import("./host.js?absent");
  check("host 缺席：bridgeActive() 为 false", bridgeActive() === false);
  const before = new Set(Object.keys(globalThis));
  await import("./env.js?absent");
  const added = Object.keys(globalThis).filter((k) => !before.has(k));
  check("host 缺席：核心安装空转（未写 window 全局）", !added.includes("window"), `新增了 ${added.join(",")}`);
}

// ---------------------------------------------------------------- 场景 B：mock host 全流程
// mock 平台端点：可编程画布/图片/音频，模拟本渠道迭代踩出的平台形态。

function makeMockHost() {
  const canvases = [];
  const images = [];
  const touchHandlers = [];
  const keyHandlers = [];
  const lifecycle = { show: [], hide: [], resize: [], error: [] };
  const storage = new Map();
  const host = {
    platformId: "mock",
    available: () => true,
    getViewport: () => ({ width: 844, height: 390, dpr: 2 }),
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 16),
    cancelAnimationFrame: (id) => clearTimeout(id),
    createScreenCanvas: () => {
      const c = { width: 300, height: 150, style: {}, getContext: () => null, addEventListener() {}, removeEventListener() {} };
      canvases.push(c);
      return c;
    },
    createOffscreenCanvas: (w, h) => {
      const c = { width: w || 300, height: h || 150, style: {}, getContext: () => ({}), addEventListener() {}, removeEventListener() {} };
      canvases.push(c);
      return c;
    },
    createImage: () => {
      const img = { width: 0, height: 0, __nativeImage: true, style: {} };
      let src = "";
      Object.defineProperty(img, "src", {
        get: () => src,
        set(v) {
          src = String(v);
          images.push(src);
          if (src.startsWith("data:")) {
            img.width = 4;
            img.height = 4;
            setTimeout(() => img.onload && img.onload({ width: 4, height: 4 }), 0);
          } else {
            setTimeout(() => img.onerror && img.onerror({ errMsg: "fs miss" }), 0);
          }
        },
        configurable: true,
      });
      return img;
    },
    createAudioContext: () => {
      // 平台真实形态：resume 为只读访问器（getter-only），返回值非 Promise
      const ctx = { state: "suspended", sampleRate: 44100, destination: {}, listener: {} };
      let resumed = false;
      Object.defineProperty(ctx, "resume", {
        get: () => () => {
          resumed = true;
          return undefined;
        },
        configurable: true,
      });
      ctx.__wasResumed = () => resumed;
      return ctx;
    },
    onTouchStart: (fn) => touchHandlers.push({ type: "start", fn }),
    onTouchMove: (fn) => touchHandlers.push({ type: "move", fn }),
    onTouchEnd: (fn) => touchHandlers.push({ type: "end", fn }),
    onTouchCancel: (fn) => touchHandlers.push({ type: "cancel", fn }),
    onKeyDown: (fn) => keyHandlers.push({ type: "down", fn }),
    onKeyUp: (fn) => keyHandlers.push({ type: "up", fn }),
    onShow: (fn) => lifecycle.show.push(fn),
    onHide: (fn) => lifecycle.hide.push(fn),
    onWindowResize: (fn) => lifecycle.resize.push(fn),
    onError: (fn) => lifecycle.error.push(fn),
    storageGet: (k) => storage.get(k) ?? null,
    storageSet: (k, v) => storage.set(k, v),
    storageRemove: (k) => storage.delete(k),
    __canvases: canvases,
    __images: images,
    __touchHandlers: touchHandlers,
    __keyHandlers: keyHandlers,
    __lifecycle: lifecycle,
  };
  return host;
}

const { setHost, host } = await import("./host.js");
const { assertHost, HOST_SURFACE, GLOBAL_SURFACE } = await import("./contract.js");

// assertHost 负例：缺方法注册即抛错（含方法名）
let assertThrew = null;
try {
  assertHost({ platformId: "bad", available: () => true });
} catch (e) {
  assertThrew = e;
}
check(
  "assertHost：缺方法注册即抛错且报出方法名",
  assertThrew !== null && HOST_SURFACE.some((m) => assertThrew.message.includes(m)),
  assertThrew && assertThrew.message,
);

const mock = makeMockHost();
setHost(mock);
check("setHost：完整端点注册通过", host().platformId === "mock");

// 核心链按渠道入口同序安装（平台端点已注册 → 激活）
await import("./env.js");
await import("./canvas.js");
await import("./codec.js");
await import("./url.js");
await import("./image.js");
await import("./dom.js");
await import("./http.js");
await import("./events.js");
await import("./audio.js");
await import("./storage.js");
await import("./load-module.js");

// 全局覆盖：GLOBAL_SURFACE 全部就位（__TVE_BUILD_DATA 例外——由 data-bridge 安装，
// 其依赖的 data.js 是导出期产物，此处以静态接线断言代替）
const missingGlobals = GLOBAL_SURFACE.filter(
  (name) => name !== "__TVE_BUILD_DATA" && typeof globalThis[name] === "undefined",
);
check("GLOBAL_SURFACE：清单全部安装", missingGlobals.length === 0, `缺 ${missingGlobals.join(",")}`);
{
  const src = fs.readFileSync(new URL("./data-bridge.js", import.meta.url), "utf8");
  check(
    "data-bridge：静态接线断言（import data.js + __TVE_BUILD_DATA 安装）",
    src.includes('from "./data.js"') && src.includes('setGlobal("__TVE_BUILD_DATA"'),
  );
}

// 首个 canvas 归渲染器
const screen = mock.__canvases[0];
const first = globalThis.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
const second = globalThis.document.createElement("canvas");
check(
  "首 canvas 归渲染器：首调 = 屏上画布，后续走离屏链",
  first === screen && second !== first && second !== screen,
);

// 图片：同对象增强（原生身份）+ src 桥接（包内路径 → data URL）
const img = globalThis.document.createElementNS("http://www.w3.org/1999/xhtml", "img");
globalThis.__TVE_BUILD_DATA = {
  config: {},
  assets: { "assets/tex.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") },
};
const imgLoad = new Promise((resolve) => {
  img.addEventListener("load", () => resolve("load"));
  img.addEventListener("error", () => resolve("error"));
});
img.src = "assets/tex.png";
const imgOutcome = await Promise.race([imgLoad, new Promise((r) => setTimeout(() => r("timeout"), 1000))]);
check(
  "图片：同对象增强（元素 = 原生）且 src 桥接 data URL",
  imgOutcome === "load" && img.__nativeImage === true && mock.__images[0].startsWith("data:image/png;base64,"),
  `outcome=${imgOutcome}`,
);

// 图片退化：src 不可重定义（无 setter 的只读访问器）→ 包装器 + 桥接仍生效
{
  const readOnly = {};
  let inner = "";
  Object.defineProperty(readOnly, "src", { get: () => inner, configurable: true }); // 无 setter
  const { host: h } = await import("./host.js");
  const realCreate = h().createImage;
  h().createImage = () => readOnly;
  const wrapped = globalThis.document.createElement("img");
  h().createImage = realCreate;
  check(
    "图片退化：src 不可重定义 → 包装器（桥接仍生效）",
    wrapped !== readOnly && wrapped.__tveNativeImage === readOnly,
  );
}

// createImageBitmap：解析出原生平台 image（纹理源身份）
{
  const blobLike = { __bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), type: "image/png" };
  const bmp = await globalThis.createImageBitmap(blobLike);
  check("createImageBitmap：解析出原生 image（纹理源身份 + close）", bmp.__nativeImage === true && typeof bmp.close === "function");
}

// 音频：getter-only resume 平台形态下 Proxy 门面不抛错
{
  const Ctor = globalThis.AudioContext;
  const ctx = new Ctor();
  let promiseOk = false;
  let threw = null;
  try {
    const p = ctx.resume();
    promiseOk = p && typeof p.then === "function";
    await p;
  } catch (e) {
    threw = e;
  }
  check(
    "音频门面：getter-only resume 不抛错、返回 Promise、state 转 running",
    threw === null && promiseOk && ctx.state === "running" && ctx.__tveNative.__wasResumed() === true,
    threw && threw.message,
  );
}

// fetch：内联资产表命中
{
  const res = await globalThis.fetch("assets/tex.png");
  const buf = new Uint8Array(await res.arrayBuffer());
  check(
    "fetch：内联表命中（相对路径归一化 → 200 + 字节一致）",
    res.ok === true && buf[0] === 0x89 && buf[1] === 0x50,
  );
}

// 事件：平台触摸 → canvas 与 window 双监听面派发
{
  const { canvasEvents } = await import("./canvas.js");
  const { winEvents } = await import("./env.js");
  let canvasHits = 0;
  let winHits = 0;
  canvasEvents.on("pointerdown", () => canvasHits++);
  winEvents.on("pointerdown", () => winHits++);
  const binding = mock.__touchHandlers.find((b) => b.type === "start");
  binding.fn({ identifier: 1, clientX: 80, clientY: 300 });
  check("事件：触摸 → canvas 与 window 双面派发 pointerdown", canvasHits === 1 && winHits === 1);
}

// 存储：端点读写回环
{
  globalThis.localStorage.setItem("k", "v");
  check("存储：localStorage 形态接端点回环", globalThis.localStorage.getItem("k") === "v");
}

// ---------------------------------------------------------------- 场景 C：微信平台端点（wx 桩）
// wx 桩置于 globalThis 后导入平台端点：assertHost 通过 + 能力面可用。
{
  const wxStorageBox = {};
  globalThis.wx = {
    platform: "devtools",
    getSystemInfoSync: () => ({ windowWidth: 800, windowHeight: 360, pixelRatio: 3 }),
    createCanvas: () => ({ width: 300, height: 150, style: {}, getContext: () => null }),
    // 真实 wx 形态：object 参数（{type,width,height}）
    createOffscreenCanvas: (opts) => ({ width: (opts && opts.width) || 300, height: (opts && opts.height) || 150, style: {}, getContext: () => ({}) }),
    createImage: () => ({ width: 0, height: 0 }),
    createWebAudioContext: () => ({ state: "running" }),
    getStorageSync: () => wxStorageBox,
    setStorageSync: (_k, v) => Object.assign(wxStorageBox, v),
    removeStorageSync() {},
    onTouchStart() {},
    onKeyDown() {},
    onShow() {},
    onHide() {},
    onWindowResize() {},
    onError() {},
    requestAnimationFrame: (fn) => setTimeout(fn, 16),
    cancelAnimationFrame: (id) => clearTimeout(id),
  };
  const endpoint = await import("./platforms/wechat.js");
  const { host: h } = await import("./host.js");
  check("微信端点：assertHost 通过并注册", h().platformId === "wechat");
  const vp = h().getViewport();
  check("微信端点：视口取自系统信息", vp.width === 800 && vp.height === 360 && vp.dpr === 3);
  const off = h().createOffscreenCanvas(64, 32);
  check("微信端点：离屏画布兜底链可用", off && off.width === 64);
  check("微信端点：storage 回环", (h().storageSet("a", "b"), h().storageGet("a") === "b"));
}

// ---------------------------------------------------------------- 汇总
console.log(`\n契约一致性：${pass} 过 / ${fail} 败`);
if (fail > 0) {
  console.log("[bridge-spec] 判定：失败");
  process.exit(1);
}
console.log("[bridge-spec] 判定：通过");
process.exit(0);
