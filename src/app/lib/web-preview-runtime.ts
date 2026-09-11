// 网页运行产物（public/web-preview + public/engine）共享读取：网页预览面板与
// 构建导出面板共用，避免两处文件清单漂移。运行时随编辑器打包（离线可用），
// fetch 一次以文本传入 Rust。
//
// 文件清单不在本模块手工维护：由 vite.config.ts 的索引插件扫描源目录生成到
// src/generated/web-preview-files.ts（开发服务器与构建时自动重建）——运行时
// 新增/删除文件（如 layerpass.mjs）即自动进产物，不再出现漏登记 404。

import {
  WEB_PREVIEW_PHYSICS_FILES_BY_BACKEND,
  WEB_PREVIEW_RUNTIME_FILES,
  WEB_PREVIEW_WEBGPU_FILES,
} from "../../generated/web-preview-files";

export { WEB_PREVIEW_PHYSICS_FILES_BY_BACKEND, WEB_PREVIEW_RUNTIME_FILES, WEB_PREVIEW_WEBGPU_FILES };

export interface WebPreviewRuntimeOptions {
  /** 场景启用了物理 → 物理运行时随导出（缺省 false） */
  includePhysics?: boolean;
  /** 物理后端 id（physics.backend；缺省/未知回退 rapier） */
  physicsBackend?: string;
  /** 项目渲染后端为 WebGPU/自动 → three 的 WebGPU 构建与粒子 TSL 材质随导出（缺省 false） */
  includeWebgpu?: boolean;
}

/** 运行时单文件文本缓存（key = 产物内相对路径）。
 * 运行时文件随编辑器打包、内容不可变（应用更新即整体换版本），预览面板刷新/
 * 构建导出/开发者服务预览会反复读取同一批文件（含 three.min.js 等大文件），
 * 按文件记忆化后每个文件整个应用生命周期内最多跨 IPC 传输一次。 */
const runtimeTextCache = new Map<string, Promise<string>>();

function fetchRuntimeText(rel: string): Promise<string> {
  let p = runtimeTextCache.get(rel);
  if (!p) {
    const url = rel.startsWith("engine/") ? `/${rel}` : `/web-preview/${rel}`;
    p = fetch(url).then((res) => {
      if (!res.ok) {
        runtimeTextCache.delete(rel); // 失败不缓存，下次重试
        throw new Error(`读取网页运行时失败: ${url} (${res.status})`);
      }
      return res.text();
    });
    runtimeTextCache.set(rel, p);
  }
  return p;
}

/** 读取网页运行产物文本：index.html/player.mjs 相对 public/web-preview，
 *  engine/** 相对 public 根；key 为产物内相对路径。
 *  文件相互独立，全部并行拉取（首次后命中缓存，近似零开销）。 */
export async function fetchWebPreviewRuntimeTexts(
  opts?: WebPreviewRuntimeOptions,
): Promise<Record<string, string>> {
  const list = [
    ...WEB_PREVIEW_RUNTIME_FILES,
    ...(opts?.includePhysics
      ? (WEB_PREVIEW_PHYSICS_FILES_BY_BACKEND[opts.physicsBackend ?? ""] ??
        WEB_PREVIEW_PHYSICS_FILES_BY_BACKEND.rapier ??
        [])
      : []),
    ...(opts?.includeWebgpu ? WEB_PREVIEW_WEBGPU_FILES : []),
  ];
  const texts = await Promise.all(list.map((rel) => fetchRuntimeText(rel)));
  const files: Record<string, string> = {};
  for (let i = 0; i < list.length; i++) files[list[i]] = texts[i];
  return files;
}

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
 * 解析项目配置的渲染后端是否需要 WebGPU 运行时（three 的 WebGPU 构建 + 粒子 TSL 材质）。
 * 配置读取失败/解析失败一律视为不需要（产物按 WebGL 处理；播放器端仍会在 WebGPU
 * 不可用时回退，故 false 只代表"不随产物多带 ~670KB"）。
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
      typeof cfg.physics?.backend === "string" &&
      cfg.physics.backend in WEB_PREVIEW_PHYSICS_FILES_BY_BACKEND
        ? cfg.physics.backend
        : null;
    return { enabled, backend };
  } catch {
    return { enabled: false, backend: null };
  }
}

/** 替换 index.html 的 <title>（构建渠道自定义页面标题用） */
export function withHtmlTitle(html: string, title: string): string {
  if (!title.trim()) return html;
  return html.replace(/<title>[\s\S]*?<\/title>/, `<title>${title.trim()}</title>`);
}
