// 构建配置持久化（归属项目自身，写项目根 build.config.json；与编辑器无关）。
// 类型 = BuildOptions 去掉运行期字段（root/outDir）——面板状态与持久化同一份
// 字段口径，不再两份手写。
import { api } from "../../../lib/api";
import { defaultExportTemplateId } from "./web-artifacts";
import type { BuildOptions } from "./options";

/** 项目根下的构建配置文件（与 project.config.json 同级同风格） */
export const BUILD_CONFIG_REL = "build.config.json";

/** 持久化的构建配置（BuildOptions 去运行期字段） */
export type BuildPrefs = Omit<BuildOptions, "root" | "outDir">;

/** 读取项目构建配置（文件缺失/损坏时返回 null，面板用默认值） */
export async function loadBuildPrefs(root: string | null): Promise<BuildPrefs | null> {
  if (!root) return null;
  try {
    const text = await api.readText(root, BUILD_CONFIG_REL);
    const cfg = JSON.parse(text) as Record<string, unknown>;
    return {
      channel: cfg.channel === "wechat" ? "wechat" : "web",
      scenes: Array.isArray(cfg.scenes) ? cfg.scenes.filter((s) => typeof s === "string") : [],
      mainScene: typeof cfg.mainScene === "string" ? cfg.mainScene : "",
      title: typeof cfg.title === "string" ? cfg.title : "",
      debug: cfg.debug !== false,
      templates: Array.isArray(cfg.templates)
        ? cfg.templates.filter((s) => typeof s === "string")
        : [defaultExportTemplateId()],
      gzip: cfg.gzip === true,
      release: cfg.release === true,
      cdn: cfg.cdn === true,
      gzipBase: typeof cfg.gzipBase === "string" ? cfg.gzipBase : "",
      cdnBase: typeof cfg.cdnBase === "string" ? cfg.cdnBase : "",
      wechatAppId: typeof cfg.wechatAppId === "string" ? cfg.wechatAppId : "",
      wechatOrientation: cfg.wechatOrientation === "landscape" ? "landscape" : "portrait",
      wechatSubpackages: cfg.wechatSubpackages === true,
      wechatDiag: cfg.wechatDiag === true,
      wechatSubpackageSize:
        typeof cfg.wechatSubpackageSize === "number" && Number.isFinite(cfg.wechatSubpackageSize)
          ? Math.min(4, Math.max(1, Math.round(cfg.wechatSubpackageSize)))
          : 2,
    };
  } catch {
    return null;
  }
}

/** 保存构建配置到项目根 build.config.json */
export async function saveBuildPrefs(root: string | null, prefs: BuildPrefs): Promise<void> {
  if (!root) return;
  const next = {
    channel: prefs.channel,
    scenes: prefs.scenes,
    mainScene: prefs.mainScene,
    title: prefs.title,
    debug: prefs.debug,
    templates: prefs.templates,
    gzip: prefs.gzip,
    release: prefs.release,
    cdn: prefs.cdn,
    gzipBase: prefs.gzipBase,
    cdnBase: prefs.cdnBase,
    wechatAppId: prefs.wechatAppId ?? "",
    wechatOrientation: prefs.wechatOrientation ?? "portrait",
    wechatSubpackages: prefs.wechatSubpackages === true,
    wechatDiag: prefs.wechatDiag === true,
    wechatSubpackageSize:
      typeof prefs.wechatSubpackageSize === "number" && Number.isFinite(prefs.wechatSubpackageSize)
        ? Math.min(4, Math.max(1, Math.round(prefs.wechatSubpackageSize)))
        : 2,
  };
  await api.writeText(root, BUILD_CONFIG_REL, JSON.stringify(next, null, 2));
}
