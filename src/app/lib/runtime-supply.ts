// 渠道运行时供给（统一事实源）：清单来自 generated/channel-runtimes（由
// runtime/scripts/manifest.mjs 生成），本模块负责按渠道 + 项目配置组装清单并
// 拉取运行时文本。web（预览面板/远程命令/构建导出）与 wechat（构建导出）共用：
// 一份缓存、一个 HTML 兜底守卫、一套条件组映射，不再有渠道各自的 fetch 实现。
//
// 兼容性：web-preview-runtime.ts 为本模块的全量 re-export 门面，历史消费者
// （WebPreviewPanel / remoteCommands / useAssetItemActions / build-export）
// 的 import 无需改动。

import {
  CHANNEL_RUNTIMES,
  type ChannelRuntimeFile,
} from "../../generated/channel-runtimes";

export type RuntimeChannel = "web" | "wechat";

/** 运行时按需打包的条件项（体积大的可选运行时） */
export interface ChannelRuntimeOptions {
  /** 场景启用了物理 → 物理运行时随导出（缺省 false） */
  includePhysics?: boolean;
  /** 物理后端 id（physics.backend；缺省/未知回退 rapier） */
  physicsBackend?: string | null;
  /** 项目渲染后端为 WebGPU/自动 → three 的 WebGPU 构建与粒子 TSL 材质随导出 */
  includeWebgpu?: boolean;
  /** 项目启用 Draco 压缩 → Draco wasm 解码器（wrapper JS + .wasm）随导出 */
  includeDracoDecoder?: boolean;
  /** 项目启用纹理压缩 → Basis 转码器（胶水 JS + .wasm）随导出 */
  includeBasisDecoder?: boolean;
}

/** 运行时单文件文本缓存（key = fetch URL）。
 * 运行时文件随编辑器打包、内容不可变（应用更新即整体换版本），预览面板刷新/
 * 构建导出/开发者服务预览会反复读取同一批文件（含 three.min.js 等大文件），
 * 按文件记忆化后每个文件整个应用生命周期内最多跨 IPC 传输一次。 */
const runtimeTextCache = new Map<string, Promise<string>>();

function fetchRuntimeText(url: string, cacheKey: string): Promise<string> {
  let p = runtimeTextCache.get(cacheKey);
  if (!p) {
    p = fetch(url).then(async (res) => {
      if (!res.ok) {
        runtimeTextCache.delete(cacheKey); // 失败不缓存，下次重试
        throw new Error(`读取运行时失败: ${url} (${res.status})`);
      }
      const text = await res.text();
      // dev 服务器对缺失文件按 SPA 兜底返回 index.html（状态仍是 200）：
      // 运行时产物目录（public/engine 等）为纯构建产物（首次构建前/再生窗口
      // 可能缺文件），若不拦截会把 HTML 当模块文本内联 → SyntaxError。
      // 报错不入缓存，构建补齐后自动恢复。
      // 例外：产物里的 index.html 本身就是 HTML（清单条目），不得误判为兜底页。
      const htmlByDesign = /\.html?$/i.test(url);
      if (!htmlByDesign && /^\s*<(!doctype|html)/i.test(text)) {
        runtimeTextCache.delete(cacheKey);
        throw new Error(
          `读取运行时失败: ${url} 返回 HTML 兜底页（运行时文件缺失，请等待构建完成或重启编辑器）`,
        );
      }
      return text;
    });
    runtimeTextCache.set(cacheKey, p);
  }
  return p;
}

/** .wasm base64 缓存（key = fetch URL）：与文本缓存同策略——运行时文件随编辑器
 *  打包内容不可变，而 base64 编码是 CPU 密集操作且产物体积大（三物理后端 +
 *  draco/basis 解码器全开约 15MB base64），预览/构建反复导出时按 URL 记忆化，
 *  每个文件整个应用生命周期内最多 fetch+编码一次。 */
const runtimeWasmCache = new Map<string, Promise<string>>();

/** .wasm 运行时文件：二进制经文本 IPC 会 UTF-8 损坏，改读 arrayBuffer 并以
 *  base64 进 files map（Rust 管线按 .wasm 键解码为二进制写盘）。 */
function fetchRuntimeWasmBase64(url: string): Promise<string> {
  let p = runtimeWasmCache.get(url);
  if (!p) {
    p = fetch(url).then(async (res) => {
      if (!res.ok) {
        runtimeWasmCache.delete(url); // 失败不缓存，下次重试
        throw new Error(`读取运行时失败: ${url} (${res.status})`);
      }
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    });
    runtimeWasmCache.set(url, p);
  }
  return p;
}

/** 拉取指定渠道的运行时文本（base + 条件组，按清单 key 组装 files map） */
export async function fetchChannelRuntimeFiles(
  channel: RuntimeChannel,
  opts: ChannelRuntimeOptions = {},
): Promise<Record<string, string>> {
  const spec = CHANNEL_RUNTIMES[channel];
  if (!spec) throw new Error(`未知构建渠道: ${channel}`);

  // 条件组映射（web 与 wechat 的可选面不同，键由 manifest.mjs 定义）
  const groupKeys: string[] = [];
  if (channel === "web") {
    if (opts.includePhysics) {
      const key = `physics:${opts.physicsBackend || "rapier"}`;
      // 未知后端回退 rapier（与历史行为一致）
      groupKeys.push(spec.groups[key] ? key : "physics:rapier");
    }
    if (opts.includeWebgpu) groupKeys.push("webgpu");
    if (opts.includeDracoDecoder) groupKeys.push("draco");
    if (opts.includeBasisDecoder) groupKeys.push("basis");
  } else if (opts.includePhysics) {
    // wechat：物理引擎按后端随包（rapier/jolt/ammo CJS 预转换产物；真机 wasm
    // 由桥接层垫片经 WXWebAssembly 实例化）。未知后端回退 rapier（与 web 同规则）
    const key = `physics:${opts.physicsBackend || "rapier"}`;
    groupKeys.push(spec.groups[key] ? key : "physics:rapier");
  }

  const list: ChannelRuntimeFile[] = [...spec.base, ...groupKeys.flatMap((k) => spec.groups[k] ?? [])];
  const texts = await Promise.all(
    list.map((f) => (f.key.endsWith(".wasm") ? fetchRuntimeWasmBase64(f.url) : fetchRuntimeText(f.url, f.url))),
  );
  const files: Record<string, string> = {};
  for (let i = 0; i < list.length; i++) files[list[i].key] = texts[i];
  return files;
}

/** web 预览/构建的运行时拉取（原 web-preview-runtime 入口名，语义不变） */
export function fetchWebPreviewRuntimeTexts(
  opts?: ChannelRuntimeOptions,
): Promise<Record<string, string>> {
  return fetchChannelRuntimeFiles("web", opts ?? {});
}

// ---------------------------------------------------------------------------
// 项目配置解析（构建/预览前判定可选运行时的启用状态）
// ---------------------------------------------------------------------------

/**
 * 解析项目配置文本是否启用物理（physics.physicsEnabled === true）。
 * 文本读取失败/解析失败一律视为未启用（导出按未用物理处理）。
 */
export function configUsesPhysics(configText: string | null | undefined): boolean {
  return readPhysicsConfig(configText).enabled;
}

/** 解析项目配置的物理后端 id（未启用/非法/缺失返回 null；调用方回退 rapier） */
export function configPhysicsBackend(configText: string | null | undefined): string | null {
  const { enabled, backend } = readPhysicsConfig(configText);
  return enabled ? backend : null;
}

/**
 * 解析项目配置的渲染后端是否需要 WebGPU 运行时（three 的 WebGPU 构建 + 粒子
 * TSL 材质）。配置读取失败/解析失败一律视为不需要（产物按 WebGL 处理）。
 */
export function configUsesWebgpu(configText: string | null | undefined): boolean {
  if (!configText) return false;
  try {
    const cfg = JSON.parse(configText) as { renderer?: unknown };
    return cfg.renderer === "webgpu" || cfg.renderer === "auto";
  } catch {
    return false;
  }
}

/** 解析项目配置是否启用 Draco 压缩（resources.dracoCompression === true） */
export function configUsesDracoCompression(configText: string | null | undefined): boolean {
  return readResourcesConfig(configText).dracoCompression;
}

/** 解析项目配置是否启用纹理压缩（resources.textureCompression === true） */
export function configUsesTextureCompression(configText: string | null | undefined): boolean {
  return readResourcesConfig(configText).textureCompression;
}

function readPhysicsConfig(configText: string | null | undefined): {
  enabled: boolean;
  backend: string | null;
} {
  if (!configText) return { enabled: false, backend: null };
  try {
    const cfg = JSON.parse(configText) as {
      physics?: { physicsEnabled?: unknown; backend?: unknown };
    };
    const enabled = cfg.physics?.physicsEnabled === true;
    const backend =
      typeof cfg.physics?.backend === "string" ? (cfg.physics.backend as string) : null;
    return { enabled, backend };
  } catch {
    return { enabled: false, backend: null };
  }
}

function readResourcesConfig(configText: string | null | undefined): {
  dracoCompression: boolean;
  textureCompression: boolean;
} {
  if (!configText) return { dracoCompression: false, textureCompression: false };
  try {
    const cfg = JSON.parse(configText) as {
      resources?: { dracoCompression?: unknown; textureCompression?: unknown };
    };
    return {
      dracoCompression: cfg.resources?.dracoCompression === true,
      textureCompression: cfg.resources?.textureCompression === true,
    };
  } catch {
    return { dracoCompression: false, textureCompression: false };
  }
}

/** 替换 index.html 的 <title>（构建渠道自定义页面标题用） */
export function withHtmlTitle(html: string, title: string): string {
  if (!title.trim()) return html;
  return html.replace(/<title>[\s\S]*?<\/title>/, `<title>${title.trim()}</title>`);
}
