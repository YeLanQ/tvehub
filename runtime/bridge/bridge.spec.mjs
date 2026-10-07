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
  const { bridgeActive } = await import("./host.ts?absent");
  check("host 缺席：bridgeActive() 为 false", bridgeActive() === false);
  const before = new Set(Object.keys(globalThis));
  await import("./env.ts?absent");
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
  const wasmCalls = [];
  const packageFiles = new Map();
  const host = {
    platformId: "mock",
    available: () => true,
    instantiateWasm: (bytes, imports) => {
      wasmCalls.push({ bytes, imports });
      return Promise.resolve({ module: {}, instance: { exports: {} } });
    },
    readPackageFile: (rel) => packageFiles.get(String(rel)) ?? null,
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
    // 平台 Worker 缺省不支持（worker 桥语义在专设场景以可编程桩验证）
    createWorker: () => null,
    __canvases: canvases,
    __images: images,
    __touchHandlers: touchHandlers,
    __keyHandlers: keyHandlers,
    __lifecycle: lifecycle,
    __wasmCalls: wasmCalls,
    __packageFiles: packageFiles,
  };
  return host;
}

const { setHost, host } = await import("./host.ts");
const { assertHost, HOST_SURFACE, GLOBAL_SURFACE } = await import("./contract.ts");

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
await import("./env.ts");
await import("./canvas.ts");
await import("./codec.ts");
await import("./url.ts");
await import("./image.ts");
await import("./dom.ts");
await import("./http.ts");
await import("./events.ts");
await import("./audio.ts");
await import("./storage.ts");
await import("./worker.ts");
await import("./load-module.ts");

// 全局覆盖：GLOBAL_SURFACE 全部就位（__TVE_BUILD_DATA 例外——由 data-bridge 安装，
// 其依赖的 data.js 是导出期产物，此处以静态接线断言代替）
const missingGlobals = GLOBAL_SURFACE.filter(
  (name) => name !== "__TVE_BUILD_DATA" && typeof globalThis[name] === "undefined",
);
check("GLOBAL_SURFACE：清单全部安装", missingGlobals.length === 0, `缺 ${missingGlobals.join(",")}`);
{
  // 钩子名经 protocol.ts 单源引用后，源文本断言同步为「protocol 导入 + 协议名安装」
  const src = fs.readFileSync(new URL("./data-bridge.ts", import.meta.url), "utf8");
  check(
    "data-bridge：静态接线断言（import data.js + __TVE_BUILD_DATA 安装）",
    src.includes('from "./data.js"') &&
      src.includes('from "./protocol.ts"') &&
      src.includes("setGlobal(TVE_BUILD_DATA"),
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
  const { host: h } = await import("./host.ts");
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
  const { canvasEvents } = await import("./canvas.ts");
  const { winEvents } = await import("./env.ts");
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

// 资产文件化清单兜底：内联表 miss → assetFiles 映射 → readPackageFile 字节
// （fetch 垫片 / Image src 桥接 / pak native 回退链共用的同一收口）
{
  const { lookupAssetBytes, fetchShim } = await import("./http.ts");
  const prevData = globalThis.__TVE_BUILD_DATA;
  globalThis.__TVE_BUILD_DATA = {
    config: { debug: true },
    assets: {},
    assetFiles: { "assets/tex/a.png": "assets/abc123.png" },
  };
  mock.__packageFiles.set("assets/abc123.png", new Uint8Array([1, 2, 3, 4]).buffer);
  const bytes = lookupAssetBytes("assets/tex/a.png");
  check("资产文件化：内联 miss → 清单 → readPackageFile 字节", !!bytes && bytes.length === 4 && bytes[0] === 1);
  const res = await fetchShim("./assets/tex/a.png");
  check("资产文件化：fetch 垫片经清单命中 200", res.ok === true);
  check("资产文件化：清单未命中返回 null（404 语义不变）", lookupAssetBytes("assets/none.png") === null);
  globalThis.__TVE_BUILD_DATA = prevData;
  mock.__packageFiles.delete("assets/abc123.png");
}

// ---------------------------------------------------------------- 场景 C：微信平台端点（wx 桩）
// wx 桩置于 globalThis 后导入平台端点：assertHost 通过 + 能力面可用。
{
  const wxStorageBox = {};
  const wasmWrites = [];
  const wasmInstantiates = [];
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
    env: { USER_DATA_PATH: "wxfile://usr" },
    getFileSystemManager: () => ({
      writeFileSync: (path, data, encoding) => wasmWrites.push({ path, data, encoding }),
    }),
  };
  // 真机形态：标准 WebAssembly 缺位、WXWebAssembly.instantiate 只认文件路径
  globalThis.WXWebAssembly = {
    instantiate: (pathOrBuffer, imports) => {
      wasmInstantiates.push({ arg: pathOrBuffer, imports });
      return Promise.resolve({ module: {}, instance: { exports: {} } });
    },
  };
  const endpoint = await import("./platforms/wechat.ts");
  const { host: h } = await import("./host.ts");
  check("微信端点：assertHost 通过并注册", h().platformId === "wechat");
  const vp = h().getViewport();
  check("微信端点：视口取自系统信息", vp.width === 800 && vp.height === 360 && vp.dpr === 3);
  const off = h().createOffscreenCanvas(64, 32);
  check("微信端点：离屏画布兜底链可用", off && off.width === 64);
  check("微信端点：storage 回环", (h().storageSet("a", "b"), h().storageGet("a") === "b"));

  // instantiateWasm：字节落盘用户目录 → WXWebAssembly.instantiate(path) 文件形态
  const wasmResult = await h().instantiateWasm(new Uint8Array([1, 2, 3, 4]), { env: {} });
  check(
    "微信端点：instantiateWasm 落盘用户目录并走 WXWebAssembly 文件形态",
    wasmResult && wasmResult.instance
      && wasmWrites.length === 1
      && wasmWrites[0].encoding === "binary"
      && wasmWrites[0].path === wasmInstantiates[0].arg
      && wasmWrites[0].path.startsWith("wxfile://usr/tve-wasm-")
      && wasmWrites[0].path.endsWith(".wasm")
      && wasmInstantiates[0].imports && wasmInstantiates[0].imports.env !== undefined,
  );
  // 同字节重复实例化 → 同名文件（内容哈希稳定）
  await h().instantiateWasm(new Uint8Array([1, 2, 3, 4]), {});
  check(
    "微信端点：同内容 wasm 命名稳定",
    wasmInstantiates.length === 2 && wasmInstantiates[1].arg === wasmInstantiates[0].arg,
  );
}

// ---------------------------------------------------------------- 场景 D：WebAssembly 垫片
// node 自带原生 WebAssembly → 安装空转；垫片组装为纯函数单独验证。
{
  const before = globalThis.WebAssembly;
  const { buildWasmShim, installWasmShim, isCompleteWebAssembly, patchWasmGlobal } = await import("./wasm.ts");
  installWasmShim();
  check("wasm 垫片：完整原生 WebAssembly 在位时安装空转", globalThis.WebAssembly === before);

  const shimCalls = [];
  const shim = buildWasmShim((bytes, imports) => {
    shimCalls.push({ bytes, imports });
    return Promise.resolve({ module: {}, instance: { exports: {} } });
  });
  const r1 = await shim.instantiate(new Uint8Array([9]), { a: 1 });
  check("wasm 垫片：instantiate 委托端点（字节 + imports 透传）", r1 && r1.instance && shimCalls[0].imports.a === 1);
  await shim.instantiateStreaming({ arrayBuffer: () => Promise.resolve(new Uint8Array([8]).buffer) }, { b: 2 });
  check("wasm 垫片：instantiateStreaming 读全量字节走同链路", shimCalls[1].imports.b === 2);
  check(
    "wasm 垫片：Instance/Module/RuntimeError 构造器在位（引擎产物消费面）",
    typeof shim.Instance === "function" && typeof shim.Module === "function"
      && new shim.RuntimeError("x") instanceof Error,
  );
  check("wasm 垫片：validate 保守桩（残缺平台走非 SIMD/JS 兜底）", shim.validate() === false);
  check(
    "wasm 垫片：完整性探测（node 原生完整 / 空对象残缺）",
    isCompleteWebAssembly(globalThis.WebAssembly) === true && isCompleteWebAssembly({}) === false,
  );
  // 微信子上下文残缺形态：有 instantiate 缺 validate 等 → 成员级修补
  const partial = { instantiate: () => {}, extraNative: 1 };
  check(
    "wasm 垫片：残缺平台修补（缺的补上、原生保留）",
    patchWasmGlobal(partial, shim) === true && typeof partial.validate === "function"
      && typeof partial.Instance === "function" && partial.extraNative === 1,
  );
  const partial2 = { instantiate: () => {} };
  patchWasmGlobal(partial2, shim);
  await partial2.instantiate(new Uint8Array([1]), { c: 3 });
  check(
    "wasm 垫片：残缺平台的 instantiate 强制切到端点链路",
    partial2.instantiate === shim.instantiate && shimCalls[2].imports.c === 3,
  );
}

// ---------------------------------------------------------------- 场景 D2：桥接日志门控
// release 构建（config.debug !== true）零 console 输出；安装期日志缓冲待
// data-bridge 装配后按门控回放（?query 缓存击穿拿独立门控实例）。
// 断言在 console 恢复后进行——check 自身的输出不进采样。
{
  const { bridgeLog, flushBridgeLogs } = await import("./log.ts?gate");
  const emitted = [];
  const results = {};
  const origWarn = console.warn;
  const origLog = console.log;
  console.warn = (...a) => emitted.push(a.join(" "));
  console.log = (...a) => emitted.push(a.join(" "));

  bridgeLog("warn", "[t] buffered-install-log");
  results.buffered = emitted.length === 0;
  globalThis.__TVE_BUILD_DATA = { config: { debug: true }, assets: {} };
  flushBridgeLogs();
  bridgeLog("log", "[t] live-debug-log");
  results.debug =
    emitted.length === 2 && emitted[0].includes("buffered-install-log") && emitted[1].includes("live-debug-log");
  globalThis.__TVE_BUILD_DATA = { config: {}, assets: {} };
  flushBridgeLogs();
  bridgeLog("warn", "[t] muted-release");
  globalThis.__TVE_BUILD_DATA = undefined;
  flushBridgeLogs();
  bridgeLog("error", "[t] muted-no-config");
  results.muted = emitted.length === 2;

  console.warn = origWarn;
  console.log = origLog;
  check("日志门控：装配前缓冲不发", results.buffered);
  check("日志门控：debug 回放缓冲并实时放行", results.debug, JSON.stringify(emitted));
  check("日志门控：release/配置缺失一律静默", results.muted, JSON.stringify(emitted));
}

// ---------------------------------------------------------------- 场景 E：真机 wasm 加载链闭环
// 复刻真机实例化链（端点落盘用户目录 → WXWebAssembly 文件形态读盘编译）：
// 用手写最小 wasm 模块（导出 f() = 42）经微信端点 instantiateWasm 全链落地，
// 并断言产物侧 rapier 产物在 cjs 形态下可初始化建世界。wechat 构建链内产物
// 已就绪；独立运行缺产物时跳过产物断言（不判失败）。
{
  const { buildWasmShim } = await import("./wasm.ts");
  const fsp = await import("node:fs");
  const pathMod = await import("node:path");
  const os = await import("node:os");
  const userDir = fsp.mkdtempSync(pathMod.join(os.tmpdir(), "tve-wasm-spec-"));
  // 端点侧 wx 桩升级为真实落盘（场景 C 的对象引用仍被端点持有）
  globalThis.wx.getFileSystemManager = () => ({
    writeFileSync: (p, data) => fsp.writeFileSync(p, Buffer.from(data)),
  });
  globalThis.wx.env.USER_DATA_PATH = userDir;
  // WXWebAssembly 桩升级为真实编译：读盘字节交原生 WebAssembly（= 真机文件形态
  // 语义）；包内相对路径按微信包根（public/exports/wechat/runtime）解析，绝对
  // 路径（字节链落盘的用户目录）直接使用
  const nativeWa = globalThis.WebAssembly;
  const repoRoot = pathMod.resolve(new URL("../..", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""));
  const pkgRoot = pathMod.join(repoRoot, "public", "exports", "wechat", "runtime");
  globalThis.WXWebAssembly.instantiate = (p, imports) => {
    if (typeof p !== "string") throw new TypeError("WXWebAssembly stub: expect file path");
    const file = pathMod.isAbsolute(p) ? p : pathMod.join(pkgRoot, p);
    return nativeWa.instantiate(new Uint8Array(fsp.readFileSync(file)), imports);
  };

  // 最小 wasm：magic+version / type ()->i32 / func / export "f" / code (i32.const 42)
  const minimalWasm = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00,
    0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x2a, 0x0b,
  ]);
  try {
    const endpointInstantiate = (await import("./host.ts")).host().instantiateWasm.bind(null);
    const shim = buildWasmShim(endpointInstantiate);
    const result = await shim.instantiate(minimalWasm, {});
    const callResult = result.instance.exports.f();
    check(
      "wasm 加载链：最小 wasm 经垫片+端点落盘+文件形态编译并调用导出",
      callResult === 42,
      `exports.f() = ${callResult}`,
    );
  } catch (e) {
    check("wasm 加载链：最小 wasm 经垫片+端点落盘+文件形态编译并调用导出", false, e && e.message);
  }

  // 产物侧：rapier 产物 cjs 形态可初始化（原生编译路径；缺产物按跳过）
  const engineFile = new URL("../../public/exports/wechat/runtime/engine/runtime/physics-engines/rapier.js", import.meta.url);
  if (fs.existsSync(engineFile)) {
    try {
      const vm = await import("node:vm");
      const text = fsp.readFileSync(engineFile, "utf8");
      const wrapper = vm.runInThisContext(
        `(function (exports, require, module) {\n${text}\n})`,
        { filename: "rapier.js" },
      );
      const m = { exports: {} };
      wrapper(m.exports, () => ({}), m);
      const R = m.exports.default;
      await R.init();
      const world = new R.World({ x: 0, y: -9.81, z: 0 });
      world.timestep = 1 / 60;
      world.step();
      world.free();
      check("wasm 加载链：rapier 产物 cjs 形态初始化并步进一帧", true);
    } catch (e) {
      check("wasm 加载链：rapier 产物 cjs 形态初始化并步进一帧", false, e && (e.stack || e.message));
    }
  }
  fsp.rmSync(userDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 场景 E：平台 Worker 桥
// ns 信封多路复用（可编程 wx worker 桩）：ready 门缓冲/放行、拷贝归一（TypedArray
// → 纯数组）、上行按 ns 派发、{data} 包装解包、wasm 字节中继（读包 b64 回传/缺失
// 回 null）、不支持协议回 null、末端口关闭终结单例。
{
  const downEvents = []; // 主 → worker 下行（平台 postMessage 收到的信封）
  let fakeOnMessage = null;
  let createdPath = "";
  let terminatedCount = 0;
  const fakeWxWorker = {
    onMessage(cb) {
      fakeOnMessage = cb;
    },
    postMessage(msg) {
      downEvents.push(msg);
    },
    terminate() {
      terminatedCount++;
    },
  };
  const workerHost = makeMockHost();
  workerHost.createWorker = (path) => {
    createdPath = String(path);
    return fakeWxWorker;
  };
  workerHost.readPackageFile = (rel) =>
    rel === "engine/runtime/physics-engines/rapier.wasm"
      ? new Uint8Array([0x00, 0x61, 0x73, 0x6d]).buffer
      : null;
  setHost(workerHost);
  await import("./worker.ts?scen");
  const hook = globalThis.__tveCreateWorker;
  check("worker 桥：钩子已安装", typeof hook === "function");
  check("worker 桥：未支持协议（unknown）返回 null", hook("", "unknown") === null);

  const port = hook("", "physics");
  check("worker 桥：physics 端口创建", !!port);
  check("worker 桥：平台 createWorker 收到入口路径", createdPath === "workers/tve.js");

  // animation 协议多路复用：单实例共载双 ns（平台限额每包 1 worker），animation
  // 端口不新建平台 worker；双端口 ready 前的下行共用一道缓冲门
  const animPort = hook("", "animation");
  check("worker 桥：animation 端口创建（单实例复用）", !!animPort && createdPath === "workers/tve.js" && terminatedCount === 0);
  port.postMessage({ type: "init", verts: new Float32Array([1, 2, 3]) });
  animPort.postMessage({ type: "init", meshEntries: [] });
  check("worker 桥：ready 前双 ns 下行缓冲", downEvents.length === 0);
  fakeOnMessage({ ns: "bridge", seq: 1, payload: { t: "ready" } });
  check("worker 桥：ready 后缓冲放行（双 ns 共门）", downEvents.length === 2);
  const env0 = downEvents[0];
  const env1 = downEvents[1];
  check(
    "worker 桥：放行顺序保持 physics 先 animation 后",
    env0.ns === "physics" && env0.payload?.type === "init" && env1.ns === "animation" && env1.payload?.type === "init",
  );
  check("worker 桥：下行信封 ns/seq/payload", env0.ns === "physics" && env0.seq > 0 && !!env0.payload);
  check("worker 桥：TypedArray 拷贝归一为纯数组", Array.isArray(env0.payload.verts) && env0.payload.verts[1] === 2);

  // 上行按 ns 派发
  let got = null;
  port.onmessage = (ev) => {
    got = ev.data;
  };
  fakeOnMessage({ ns: "physics", seq: 2, payload: { type: "ready" } });
  check("worker 桥：上行按 ns 派发到端口", !!got && got.type === "ready");

  // {data} 包装解包（平台双形态）
  let wrapped = null;
  port.onmessage = (ev) => {
    wrapped = ev.data;
  };
  fakeOnMessage({ data: { ns: "physics", seq: 3, payload: { v: 9 } } });
  check("worker 桥：{data} 包装解包", !!wrapped && wrapped.v === 9);

  // wasm 字节中继：读包 b64 回传 / 缺失回 null
  fakeOnMessage({ ns: "bridge", seq: 4, payload: { t: "wasmReq", id: 7, path: "engine/runtime/physics-engines/rapier.wasm" } });
  const hit = downEvents.map((e) => e.payload).find((p) => p && p.t === "wasmRes" && p.id === 7);
  check(
    "worker 桥：wasm 字节回传 base64（wasm 魔数 AGFzbQ==）",
    !!hit && typeof hit.b64 === "string" && hit.b64.startsWith("AGFzbQ"),
  );
  fakeOnMessage({ ns: "bridge", seq: 5, payload: { t: "wasmReq", id: 8, path: "missing.wasm" } });
  const miss = downEvents.map((e) => e.payload).find((p) => p && p.t === "wasmRes" && p.id === 8);
  check("worker 桥：读包失败回传 b64 null", !!miss && miss.b64 === null);

  // 末端口关闭 → 终结平台 worker：双协议端口并存时关其一仅摘端口，全部关闭才终结；
  // 此后同协议新建 → 平台 worker 重新懒建
  port.terminate();
  check("worker 桥：仅关 physics 端口不终结单例（animation 仍开）", terminatedCount === 0);
  animPort.terminate();
  check("worker 桥：末端口（animation）关闭终结平台 worker", terminatedCount === 1);
  const port2 = hook("", "physics");
  port2.terminate();
  check("worker 桥：单例重建后再次终结", terminatedCount === 2);

  // 清理：全局钩子摘除，避免泄漏到后续求值（node 进程内全局）
  delete globalThis.__tveCreateWorker;
  setHost(mock);
}

// ---------------------------------------------------------------- 汇总
console.log(`\n契约一致性：${pass} 过 / ${fail} 败`);
if (fail > 0) {
  console.log("[bridge-spec] 判定：失败");
  process.exit(1);
}
console.log("[bridge-spec] 判定：通过");
process.exit(0);
