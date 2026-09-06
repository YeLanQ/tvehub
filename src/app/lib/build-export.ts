// 构建导出：渠道清单、构建配置（归属项目，存项目根
// build.config.json）、打包流程编排。面板组件（BuildPanel.vue）只做 Vue 绑定。

import { openUrl, openPath } from "@tauri-apps/plugin-opener";
import { api, type BuildResult } from "../../lib/api";
import {
  WEB_EXPORT_TEMPLATES,
  type BuiltinWebExportTemplateInfo,
} from "../../generated/template-registry";
import { logStore } from "../stores/log";
import { saveCurrentSceneToMain } from "./save-scene";
import { fetchWebPreviewRuntimeTexts, withHtmlTitle } from "./web-preview-runtime";

/** 构建渠道（wechat 为 UI 占位，后端未实现——构建按钮禁用并提示） */
export interface BuildChannel {
  id: "web" | "wechat";
  label: string;
  desc: string;
  supported: boolean;
}

export const BUILD_CHANNELS: BuildChannel[] = [
  { id: "web", label: "Web", desc: "打包为可部署的静态网页（player 运行时 + 场景 + 资产）", supported: true },
  { id: "wechat", label: "微信小游戏", desc: "适配微信小游戏环境（即将支持）", supported: false },
];

/** 默认导出模板 id（注册表首个；注册表为空时回退内置 multi 目录） */
export function defaultExportTemplateId(): string {
  return WEB_EXPORT_TEMPLATES[0]?.id ?? "web:multi";
}

/** 解析导出模板（id 不存在/注册表变化时回退默认模板；无模板返回 null） */
export function resolveExportTemplate(
  id: string | undefined,
): BuiltinWebExportTemplateInfo | null {
  if (id) {
    const hit = WEB_EXPORT_TEMPLATES.find((t) => t.id === id);
    if (hit) return hit;
  }
  return WEB_EXPORT_TEMPLATES[0] ?? null;
}

/** 拉取导出模板页面骨架（public/exports/web/<dir>/index.html，{{TITLE}} 由调用方替换） */
export async function fetchExportTemplateHtml(id: string): Promise<string> {
  const tpl = resolveExportTemplate(id);
  if (!tpl) throw new Error("没有可用的导出模板（public/exports/web 下未扫描到模板）");
  const res = await fetch(`/exports/web/${tpl.dir}/index.html`);
  if (!res.ok) throw new Error(`读取导出模板失败: ${tpl.dir} (HTTP ${res.status})`);
  return res.text();
}

/** 产物内单场景条目（与 Rust BuildResult.scenes 对应） */
export interface PackedScene {
  name: string;
  rel: string;
  file: string;
}

export type { BuildResult };

/** 构建配置（归属项目自身，写入项目根 build.config.json；与编辑器无关） */
export interface BuildPrefs {
  channel: BuildChannel["id"];
  /** 选中的构建场景（项目相对路径） */
  scenes: string[];
  /** 主场景（必须在 scenes 内） */
  mainScene: string;
  /** 页面标题（web 渠道） */
  title: string;
  /** 调试模式：保留运行日志转发（web 渠道） */
  debug: boolean;
  /** 导出模板 id（web 渠道；模板 mode 决定产物形态 multi/single） */
  template: string;
  /** 资产 gzip 归档（多文件写 assets.gzip；单页 base64 内联） */
  gzip: boolean;
}

/** 项目根下的构建配置文件（与 project.config.json 同级同风格） */
export const BUILD_CONFIG_REL = "build.config.json";

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
      template: typeof cfg.template === "string" ? cfg.template : defaultExportTemplateId(),
      gzip: cfg.gzip === true,
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
    template: prefs.template,
    gzip: prefs.gzip,
  };
  await api.writeText(root, BUILD_CONFIG_REL, JSON.stringify(next, null, 2));
}

/** 执行构建：保存当前场景 → fetch 导出模板页面骨架 + 网页运行时 → Rust 打包落盘 */
export async function runBuild(opts: {
  root: string;
  channel: BuildChannel["id"];
  scenes: string[];
  mainScene: string;
  title: string;
  debug: boolean;
  /** 导出模板 id（模板 mode 决定产物形态 multi/single） */
  template: string;
  gzip: boolean;
}): Promise<BuildResult> {
  // 产物内容与编辑器一致：构建前把当前编辑场景落盘（后端按磁盘内容读取）
  try {
    await saveCurrentSceneToMain();
  } catch (e) {
    logStore.log("warn", `构建前保存场景失败（按磁盘内容构建）: ${e}`, "build");
  }

  const runtime = await fetchWebPreviewRuntimeTexts();
  // 页面骨架用所选导出模板（{{TITLE}} 换页面标题）；player/libs 代码仍取运行时
  runtime["index.html"] = withHtmlTitle(await fetchExportTemplateHtml(opts.template), opts.title);

  const tpl = resolveExportTemplate(opts.template);
  const result = await api.buildExport({
    root: opts.root,
    channel: opts.channel,
    scenes: opts.scenes,
    mainScene: opts.mainScene,
    title: opts.title,
    debug: opts.debug,
    singlePage: tpl?.mode === "single",
    gzip: opts.gzip,
    files: runtime,
  });
  logStore.log("success", `构建完成: ${result.output_dir}`, "build");
  if (result.missing.length) {
    logStore.log(
      "warn",
      `构建缺失 ${result.missing.length} 项资产（已跳过）: ${result.missing.join(", ")}`,
      "build",
    );
  }
  return result;
}

/** 在系统文件管理器中打开构建输出目录 */
export async function openBuildDir(outputDir: string): Promise<void> {
  try {
    await openPath(outputDir);
  } catch (e) {
    logStore.log("error", `打开构建目录失败: ${e}`, "build");
  }
}

/** 在默认浏览器中预览构建产物（复用本地静态预览服务器，服务 build/<渠道>） */
export async function previewBuildInBrowser(
  root: string,
  channel: BuildChannel["id"],
  mainSceneName: string,
): Promise<void> {
  try {
    const base = await api.startWebPreviewServer(root, `build/${channel}`);
    const url = mainSceneName
      ? `${base}/index.html?scene=${encodeURIComponent(mainSceneName)}`
      : `${base}/index.html`;
    await openUrl(url);
    logStore.log("info", `已在浏览器打开构建预览: ${url}`, "build");
  } catch (e) {
    logStore.log("error", `构建预览失败: ${e}`, "build");
  }
}
