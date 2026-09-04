import {
  PROJECT_TEMPLATES,
  type BuiltinProjectTemplateInfo,
} from "../../generated/template-registry";

/** 工程模板：新建项目弹窗与模板管理页共用的数据结构 */
export interface ProjectTemplate extends BuiltinProjectTemplateInfo {
  id: string;
  dir: string;
  name: string;
  description: string;
  /** 模板类别标识："3d" / "empty" 等 */
  kind: string;
  files: string[];
  /** 内置与自定义模板统一：本项目模板均为内置（public 静态资源），后续自定义模板可扩展 */
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
