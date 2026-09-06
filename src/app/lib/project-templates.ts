import { PROJECT_TEMPLATES, type BuiltinProjectTemplateInfo } from "../../generated/template-registry";
import { api } from "../../lib/api";

/** 工程模板：新建项目弹窗与模板管理页共用的数据结构 */
export interface ProjectTemplate extends BuiltinProjectTemplateInfo {
  id: string;
  dir: string;
  name: string;
  description: string;
  /** 模板类别标识："3d" / "empty" 等（用户自定义统一为 "user"） */
  kind: string;
  files: string[];
  /** 内置模板（public 静态资源随 exe 内嵌）与用户自定义模板（exe 旁 public 目录）统一 */
  builtin: boolean;
  path?: string | null;
}

/** 内置工程模板（数据驱动，模板管理不硬编码；由 vite 插件扫描 public/templates 自动注册） */
export const BUILTIN_PROJECT_TEMPLATES: ProjectTemplate[] = PROJECT_TEMPLATES.map(
  (t) => ({
    ...t,
    builtin: true,
    path: null,
  }),
);

/**
 * 加载工程模板列表：内置 + exe 旁 public/templates 的用户自定义模板（同名目录内置优先）。
 * 自定义模板经 Rust scan_user_templates 运行时发现（打包后的 exe 中 public 资源已内嵌，
 * 自定义目录只能从磁盘读）；开发环境 exe 在 target/debug 下无 public 目录，仅内置生效。
 */
export async function loadProjectTemplates(): Promise<ProjectTemplate[]> {
  const list = [...BUILTIN_PROJECT_TEMPLATES];
  try {
    const users = await api.scanUserTemplates("templates");
    for (const u of users) {
      if (list.some((t) => t.dir === u.dir)) continue;
      list.push({
        id: `user:${u.dir}`,
        dir: u.dir,
        name: u.name,
        description: u.description,
        kind: "user",
        files: u.files,
        builtin: false,
        path: null,
      });
    }
  } catch {
    /* 扫描失败（无自定义目录等）时仅用内置模板 */
  }
  return list;
}

/** 新建项目弹窗的模板类别（左侧栏） */
export interface CreateCat {
  id: string;
  label: string;
  match: (t: ProjectTemplate) => boolean;
}

/**
 * 从已加载的模板动态推导新建项目弹窗的模板类别（不硬编码）。
 * - 内置模板按 kind 分组：每个 kind 一个类别，标签取该 kind 下首个模板名称。
 */
export function createProjectCats(templates: ProjectTemplate[]): CreateCat[] {
  const cats: CreateCat[] = [];
  const seenKinds = new Set<string>();
  for (const t of templates) {
    if (seenKinds.has(t.kind)) continue;
    seenKinds.add(t.kind);
    cats.push({
      id: t.kind,
      label: t.name,
      match: (x) => x.kind === t.kind,
    });
  }
  return cats;
}
