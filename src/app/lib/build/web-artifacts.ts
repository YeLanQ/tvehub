// web 渠道导出模板与导出期工件注入：内置模板（vite 插件编译期注册，随 exe 内嵌）
// + exe 旁自定义模板的统一列表、解析与页面骨架读取；导出期把入口页 HTML 按模板
// 注入 files（首个模板 → index.html，其余 → index-<模板目录>.html，{{TITLE}} 换
// 页面标题）。仅 web 渠道消费（channels.ts 的 WEB_CHANNEL.applyExportArtifacts）。
import { api } from "../../../lib/api";
import { WEB_EXPORT_TEMPLATES } from "../../../generated/template-registry";
import { logStore } from "../../stores/log";
import { withHtmlTitle } from "../web-preview-runtime";
import type { BuildOptions } from "./options";

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

/** 内置导出模板（模板文件随 exe 内嵌，打包后依然生效） */
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

/** web 渠道导出期工件注入：页面骨架用所选导出模板（{{TITLE}} 换页面标题）；
 *  player/libs 代码已在 files 里。首个模板 → index.html，其余 → index-<模板>.html；
 *  形态必须一致（多文件与单页不能混选）。返回 IPC 的 singlePage 取值。 */
export async function applyWebExportArtifacts(
  opts: BuildOptions,
  files: Record<string, string>,
): Promise<{ singlePage: boolean }> {
  const templates = await loadExportTemplates();
  const resolved = opts.templates
    .map((id) => resolveExportTemplate(id, templates))
    .filter((t): t is ExportTemplateInfo => t != null);
  if (!resolved.length) throw new Error("没有可用的导出模板（public/exports/web 下未找到模板）");
  if (resolved.some((t) => t.mode !== resolved[0].mode)) {
    throw new Error("多文件与单页模板不能混选");
  }
  files["index.html"] = withHtmlTitle(await fetchExportTemplateHtml(resolved[0]), opts.title);
  for (const t of resolved.slice(1)) {
    files[`index-${t.dir}.html`] = withHtmlTitle(await fetchExportTemplateHtml(t), opts.title);
  }
  return { singlePage: resolved[0].mode === "single" };
}
