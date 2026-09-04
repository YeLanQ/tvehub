import type { ProjectTemplate } from "./project-templates";

/**
 * 从 public 静态资源读取模板文件内容（相对路径 → 内容）。
 * 模板文件清单（files）来自 vite 插件生成的 template-registry，
 * 通过 fetch 读取 public/templates/<dir>/<rel>，供 create_project 写入项目。
 */
export async function fetchTemplateFiles(
  template: ProjectTemplate,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const rel of template.files) {
    const url = `/templates/${template.dir}/${rel}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`读取模板文件失败: ${url} (${res.status})`);
    }
    files[rel] = await res.text();
  }
  return files;
}