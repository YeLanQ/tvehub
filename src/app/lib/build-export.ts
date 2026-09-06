// 构建导出：渠道清单、构建配置（归属项目，存项目根
// build.config.json）、打包流程编排。面板组件（BuildPanel.vue）只做 Vue 绑定。

import { openUrl, openPath } from "@tauri-apps/plugin-opener";
import { api, type BuildResult } from "../../lib/api";
import { WEB_EXPORT_TEMPLATES } from "../../generated/template-registry";
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

/** 导出模板（内置 + 用户自定义统一结构） */
export interface ExportTemplateInfo {
  /** 内置 "web:<dir>" / 用户自定义 "user:<dir>" */
  id: string;
  dir: string;
  name: string;
  description: string;
  mode: "multi" | "single";
  /** 是否为用户自定义模板（exe 旁 public 目录） */
  user: boolean;
}

/** 内置导出模板（vite 插件编译期注册，模板文件随 exe 内嵌，打包后依然生效） */
export const BUILTIN_EXPORT_TEMPLATES: ExportTemplateInfo[] = WEB_EXPORT_TEMPLATES.map((t) => ({
  ...t,
  id: `web:${t.dir}`,
  user: false,
}));

/** 加载导出模板列表：内置 + exe 旁 public/exports/web 的用户自定义模板（同名目录内置优先） */
export async function loadExportTemplates(): Promise<ExportTemplateInfo[]> {
  const list = [...BUILTIN_EXPORT_TEMPLATES];
  try {
    const users = await api.scanUserTemplates("exports-web");
    for (const u of users) {
      if (list.some((t) => t.dir === u.dir)) continue;
      list.push({
        id: `user:${u.dir}`,
        dir: u.dir,
        name: u.name,
        description: u.description,
        mode: u.mode === "single" ? "single" : "multi",
        user: true,
      });
    }
  } catch (e) {
    logStore.log("warn", `扫描自定义导出模板失败: ${e}`, "build");
  }
  return list;
}

/** 默认导出模板 id（内置列表首个；无内置模板时回退 web:multi） */
export function defaultExportTemplateId(): string {
  return BUILTIN_EXPORT_TEMPLATES[0]?.id ?? "web:multi";
}

/** 解析导出模板（id 不存在时回退默认模板；列表为空返回 null） */
export function resolveExportTemplate(
  id: string | undefined,
  templates: ExportTemplateInfo[] = BUILTIN_EXPORT_TEMPLATES,
): ExportTemplateInfo | null {
  if (id) {
    const hit = templates.find((t) => t.id === id);
    if (hit) return hit;
  }
  return templates[0] ?? null;
}

/** 拉取导出模板页面骨架（{{TITLE}} 由调用方替换）：内置走内嵌静态资源，
 *  用户自定义经 Rust 读 exe 旁 public 目录 */
export async function fetchExportTemplateHtml(tpl: ExportTemplateInfo): Promise<string> {
  if (tpl.user) {
    return api.readUserTemplateText("exports-web", tpl.dir, "index.html");
  }
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
  /** 导出模板 id 列表（web 渠道；首个生成 index.html，其余生成 index-<模板>.html；
   *  多文件与单页模板不能混选） */
  templates: string[];
  /** 资产 gzip 归档（多文件写 assets.gzip；单页 base64 内联） */
  gzip: boolean;
  /** 发布模式：资源 uid 重命名 + 引用重写 + JSON 压缩 */
  release: boolean;
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
      templates: Array.isArray(cfg.templates)
        ? cfg.templates.filter((s) => typeof s === "string")
        : [defaultExportTemplateId()],
      gzip: cfg.gzip === true,
      release: cfg.release === true,
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
  /** 导出模板 id 列表（首个生成 index.html，其余生成 index-<模板>.html） */
  templates: string[];
  gzip: boolean;
  /** 发布模式：资源 uid 重命名 + 引用重写 + JSON 压缩 */
  release: boolean;
}): Promise<BuildResult> {
  // 产物内容与编辑器一致：构建前把当前编辑场景落盘（后端按磁盘内容读取）
  try {
    await saveCurrentSceneToMain();
  } catch (e) {
    logStore.log("warn", `构建前保存场景失败（按磁盘内容构建）: ${e}`, "build");
  }

  const runtime = await fetchWebPreviewRuntimeTexts();
  // 页面骨架用所选导出模板（{{TITLE}} 换页面标题）；player/libs 代码仍取运行时。
  // 首个模板 → index.html，其余 → index-<模板目录>.html；形态必须一致（面板已守卫）
  const templates = await loadExportTemplates();
  const resolved = opts.templates
    .map((id) => resolveExportTemplate(id, templates))
    .filter((t): t is ExportTemplateInfo => t != null);
  if (!resolved.length) throw new Error("没有可用的导出模板（public/exports/web 下未找到模板）");
  if (resolved.some((t) => t.mode !== resolved[0].mode)) {
    throw new Error("多文件与单页模板不能混选");
  }
  runtime["index.html"] = withHtmlTitle(await fetchExportTemplateHtml(resolved[0]), opts.title);
  for (const t of resolved.slice(1)) {
    runtime[`index-${t.dir}.html`] = withHtmlTitle(await fetchExportTemplateHtml(t), opts.title);
  }

  const result = await api.buildExport({
    root: opts.root,
    channel: opts.channel,
    scenes: opts.scenes,
    mainScene: opts.mainScene,
    title: opts.title,
    debug: opts.debug,
    singlePage: resolved[0].mode === "single",
    gzip: opts.gzip,
    release: opts.release,
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
