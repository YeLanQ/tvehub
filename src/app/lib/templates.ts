import type { ProjectTemplate } from "./project-templates";
import { api } from "../../lib/api";

/**
 * 读取模板文件内容（相对路径 → 内容），供 create_project 写入项目。
 * 模板文件清单（files）来自 template-registry（内置）/ scan_user_templates（自定义）：
 * - 内置模板：fetch public/templates/<dir>/<rel>（随 exe 内嵌，打包后可用）；
 * - 用户自定义模板：经 Rust 读 exe 旁 public/templates/<dir>/<rel>（磁盘文件）。
 */
export async function fetchTemplateFiles(
  template: ProjectTemplate,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const rel of template.files) {
    if (template.builtin === false && template.id.startsWith("user:")) {
      files[rel] = await api.readUserTemplateText("templates", template.dir, rel);
      continue;
    }
    const url = `/templates/${template.dir}/${rel}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`读取模板文件失败: ${url} (${res.status})`);
    }
    files[rel] = await res.text();
  }
  return files;
}
