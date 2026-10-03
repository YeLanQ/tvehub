// ---------------------------------------------------------------------------
// wasm 文件化装载钩子（全局契约）：物理引擎胶水（rapier/jolt/ammo，构建期经
// runtime/scripts/wasm-fileize.mjs 改写）不再把 wasm 内联进 JS，而是按产物根
// 相对路径（engine/runtime/physics-engines/*.wasm）经全局钩子加载。与微信渠道
// 桥接垫片（runtime/bridge/wasm.ts）同一钩子名与签名，各运行环境自行安装：
// - web 播放器主线程 + 物理 Worker：src/runtime/runtime/physics.ts 顶层安装；
// - 编辑器 canvas 物理（ammo 走产物 ammo-esm.mjs）：ammoBackend.loadAmmo 安装；
// - 微信渠道：桥接核心安装（WXWebAssembly 包内路径直连）；
// - 单页/内联产物：钩子的 fetch 被资产垫片（runtime/pak.ts installAssetShim）
//   命中，wasm 从内联资产表供数——加载方对产物形态无感知。
// ---------------------------------------------------------------------------

/** 全局钩子签名（与微信桥接层契约一致） */
type WasmFileHook = (
  path: string,
  imports: WebAssembly.Imports,
) => Promise<WebAssembly.WebAssemblyInstantiatedSource>;

/** Worker 上下文判定（无 document 且带 self.location——worker 脚本地址）。
 *  主线程 self === window 同样有 location，靠 document 存在性区分。 */
function workerLocationHref(): string | null {
  if (typeof document !== "undefined") return null; // 主线程
  const loc = (typeof self !== "undefined" ? (self as { location?: { href?: string } }).location : undefined) ?? null;
  return typeof loc?.href === "string" ? loc.href : null;
}

/**
 * 安装 __tveInstantiateWasmFile 钩子（幂等：已存在不覆盖，微信桥接等先行安装方优先）。
 * - Worker 环境：worker 脚本位于 <产物根>/engine/runtime/，基址取脚本 URL 上两级；
 * - 主线程：文档地址即产物根（编辑器预览 staging / web 产物 / vite public 同构）；
 * - 无文档也无 Worker 的裸环境（node 单测/脚本）：不安装，由调用方自行供桩。
 */
export function installWasmFileHook(): void {
  const g = globalThis as typeof globalThis & { __tveInstantiateWasmFile?: WasmFileHook };
  if (typeof g.__tveInstantiateWasmFile === "function") return;
  const workerHref = workerLocationHref();
  const base = workerHref != null
    ? new URL("../../", workerHref).href
    : typeof location !== "undefined"
      ? new URL("./", location.href).href
      : null;
  if (base == null) return;
  g.__tveInstantiateWasmFile = (path, imports) =>
    // 字符串而非 URL 对象：单页/内联产物的 fetch 垫片（runtime/pak.ts）只按
    // string/Request 识别入参，URL 对象会穿透垫片直落原生 fetch
    fetch(new URL(path, base).href)
      .then((res) => {
        if (!res.ok) throw new Error(`wasm 加载失败: ${path} (HTTP ${res.status})`);
        return res.arrayBuffer();
      })
      .then((bytes) => WebAssembly.instantiate(bytes, imports));
}
