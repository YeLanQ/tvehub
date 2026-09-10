// 网页运行产物（public/web-preview）共享读取：网页预览面板与构建导出面板共用，
// 避免两处文件清单漂移。运行时随编辑器打包（离线可用），fetch 一次以文本传入 Rust。

/** 网页运行产物清单：入口 index.html + player.mjs（public/web-preview），
 *  其余依赖模块在 public/engine 下——core：three.js 运行时 + 基础设施
 *  （utils/log）+ 脚本系统（tve SDK + 宿主）；runtime：场景回放系统（场景树/
 *  网格/模型/材质/天空/相机/动画/音频/物理/归档与 loaders、physics-engines）。 */
export const WEB_PREVIEW_RUNTIME_FILES = [
  "index.html",
  "player.mjs",
  "engine/core/three.core.min.js",
  "engine/core/three.module.min.js",
  "engine/core/utils.mjs",
  "engine/core/log.mjs",
  "engine/core/lights.mjs",
  "engine/core/tve.mjs",
  "engine/core/scripts.mjs",
  "engine/runtime/sky.mjs",
  "engine/runtime/material.mjs",
  "engine/runtime/mesh.mjs",
  "engine/runtime/shaderlab.mjs",
  "engine/runtime/animclip.mjs",
  "engine/runtime/nodes.mjs",
  "engine/runtime/textures.mjs",
  "engine/runtime/camera.mjs",
  "engine/runtime/stage.mjs",
  "engine/runtime/pak.mjs",
  "engine/runtime/model.mjs",
  "engine/runtime/animation.mjs",
  "engine/runtime/audio.mjs",
  "engine/runtime/physics.mjs",
  "engine/runtime/loaders/GLTFLoader.js",
  "engine/runtime/loaders/FBXLoader.js",
  "engine/runtime/loaders/OBJLoader.js",
  "engine/runtime/loaders/SkeletonUtils.js",
  "engine/runtime/loaders/BufferGeometryUtils.js",
  "engine/runtime/loaders/fflate.module.js",
  "engine/runtime/loaders/NURBSCurve.js",
  "engine/runtime/loaders/NURBSUtils.js",
];

/**
 * 物理引擎（体积大：rapier/jolt 3MB 级、ammo wasm 内联 1MB 级）。
 * 仅当导出场景启用了物理（physics.physicsEnabled === true）时才随产物打包，
 * 且按项目配置的 backend（physics.backend，缺省/未知回退 rapier，与运行时
 * physics.mjs 的收敛规则一致）只带对应后端——engine/runtime/physics.mjs 本体
 * 极小（在基础清单内），其引擎加载是惰性的，场景未启用物理时不会请求这些文件。
 */
export const WEB_PREVIEW_PHYSICS_FILES_BY_BACKEND: Record<string, string[]> = {
  rapier: ["engine/runtime/physics-engines/rapier.mjs"],
  jolt: ["engine/runtime/physics-engines/jolt.mjs"],
  ammo: [
    "engine/runtime/physics-engines/ammo/ammo-esm.mjs",
    "engine/runtime/physics-engines/ammo/ammo-glue.mjs",
    "engine/runtime/physics-engines/ammo/ammo-wasm-b64.mjs",
  ],
};

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
          WEB_PREVIEW_PHYSICS_FILES_BY_BACKEND.rapier),
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
