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
} from "../../generated/web-preview-files";

export { WEB_PREVIEW_PHYSICS_FILES_BY_BACKEND, WEB_PREVIEW_RUNTIME_FILES };

export interface WebPreviewRuntimeOptions {
  /** 场景启用了物理 → 物理运行时随导出（缺省 false） */
  includePhysics?: boolean;
  /** 物理后端 id（physics.backend；缺省/未知回退 rapier） */
  physicsBackend?: string;
}

/** 读取网页运行产物文本：index.html/player.mjs 相对 public/web-preview，
 *  engine/** 相对 public 根；key 为产物内相对路径 */
export async function fetchWebPreviewRuntimeTexts(
  opts?: WebPreviewRuntimeOptions,
): Promise<Record<string, string>> {
  const list = opts?.includePhysics
    ? [
        ...WEB_PREVIEW_RUNTIME_FILES,
        ...(WEB_PREVIEW_PHYSICS_FILES_BY_BACKEND[opts.physicsBackend ?? ""] ??
          WEB_PREVIEW_PHYSICS_FILES_BY_BACKEND.rapier ??
          []),
      ]
    : WEB_PREVIEW_RUNTIME_FILES;
  const files: Record<string, string> = {};
  for (const rel of list) {
    const url = rel.startsWith("engine/") ? `/${rel}` : `/web-preview/${rel}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`读取网页运行时失败: ${url} (${res.status})`);
    files[rel] = await res.text();
  }
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
